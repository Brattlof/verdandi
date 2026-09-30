import type {
  BudgetMode,
  CatalogEntry,
  Effort,
  HarnessId,
  InteractionMode,
  RouteDecision,
  RouteRule,
  RouteSpec,
  RouteTarget,
  RuleTrace,
  Tier,
} from "@verdandi/contracts";
import type { ResolvedPolicy } from "./policy.ts";
import type { Classifier } from "./rules.ts";
import { describeSignals, signals } from "./signals.ts";

export type Pinned = { readonly target: RouteTarget; readonly effort: Effort };

export type RouteInput = {
  /** The task's first message. */
  readonly text: string;
  readonly mode: InteractionMode;
  /** The user's choice (thread pin, picker or `@model`). It always wins. */
  readonly pin?: Pinned;
  /** The thread's warm session, and how many tokens of context it has cached. */
  readonly current?: Pinned & { readonly cachedTokens: number };
  /** Files the task touches beyond those its text names, matched against policy restrictions. */
  readonly paths?: readonly string[];
  /** Provider health and the share of quota left (0..1), by provider id (DESIGN §9.5). */
  readonly providers?: Readonly<Record<string, { readonly healthy?: boolean; readonly remaining?: number }>>;
  /** The harnesses verdandid runs; targets on any other are dropped. Absent, every harness counts. */
  readonly harnesses?: readonly HarnessId[];
  /**
   * The user approved the task's plan: route the build that follows (DESIGN §8.2 lever 3). `text` is the
   * plan, and the classifier should return the task's own class, so the class's route without its `plan` override applies.
   */
  readonly planApproved?: boolean;
};

/** No target is available at all. The message says why each one dropped out. */
export class RouterError extends Error {
  override name = "RouterError";
}

const TIERS: readonly Tier[] = ["S", "M", "L", "XL"];
const rank = (t: Tier) => TIERS.indexOf(t);
const same = (a: RouteTarget, b: RouteTarget) => a.harness === b.harness && a.provider === b.provider && a.model === b.model;

/**
 * Effective cost in dollar equivalents (DESIGN §8.3). Metered pays list price. Subscription is cheap
 * while quota is plentiful and climbs to list price as it runs out. Local is free until outcomes
 * teach it a quality penalty.
 * ponytail: one fixed token mix for every task; upgrade to per-class mixes from the usage ledger once tasks record outcomes (§8.8).
 */
const effectiveCost = (t: CatalogEntry, tokens: number, input: RouteInput, price: "blend" | "cacheWrite" = "blend") => {
  const remaining = input.providers?.[t.provider]?.remaining ?? 1;
  const access = t.access === "metered" ? 1 : t.access === "local" ? 0 : 0.2 + 0.8 * (1 - remaining) ** 2;
  const perMTok = price === "cacheWrite" ? t.price.cacheWrite : 0.8 * t.price.cacheRead + 0.15 * t.price.input + 0.05 * t.price.output;
  return (tokens / 1e6) * perMTok * access;
};

/** Balanced route, then the budget mode's changes, then the plan-phase override and its mode changes. */
const resolveSpec = (rule: RouteRule, mode: BudgetMode, planning: boolean): RouteSpec => {
  const pick = (r: RouteRule | NonNullable<RouteRule["plan"]> | undefined) => (r && mode !== "balanced" ? r[mode] : undefined);
  const layers = [rule, pick(rule), ...(planning ? [rule.plan, pick(rule.plan)] : [])].reverse();
  const prefer = layers.find((s) => s?.prefer)?.prefer;
  const effort = layers.find((s) => s?.effort)?.effort;
  return { ...(prefer && { prefer }), ...(effort && { effort }) };
};

const dollars = (n: number) => `$${n < 0.01 ? n.toPrecision(1) : n.toFixed(2)}`;
const kTokens = (n: number) => `${Math.round(n / 1000)}K`;
const describe = (t: RouteTarget, effort: Effort) => `${t.model} at ${effort} effort`;

/**
 * Stages 0–5 of the routing pipeline (DESIGN §8.4). Pure: everything it knows comes in through
 * `input` and `policy`, and the classifier is passed in. Throws a `RouterError` only when no
 * target is available at all.
 */
export const route = (input: RouteInput, policy: ResolvedPolicy, classify: Classifier): RouteDecision => {
  const trace: RuleTrace[] = [];
  const planning = input.mode === "plan" && !input.planApproved;

  // Stages 2 and 3 run even for pins, so the decision records what the user overrode.
  const sig = signals(input.text, input.mode);
  const c = classify(sig);
  const classified = { taskClass: c.taskClass, difficulty: c.difficulty, confidence: c.confidence };
  const unsure = c.lowConfidence ?? c.confidence < policy.minConfidence;
  const rule = (!unsure && policy.routes[c.taskClass]) || policy.fallback;
  const tokens = rule.tokens ?? policy.fallback.tokens ?? 0;
  const signalNotes: RuleTrace[] = [
    { stage: "signals", note: describeSignals(sig) },
    { stage: "classify", note: `${c.taskClass}, confidence ${c.confidence.toFixed(2)}, difficulty ${c.difficulty.toFixed(2)} (${c.why})` },
  ];

  // Stage 0: a pin always wins, whatever the policy says.
  if (input.pin) {
    const { target, effort } = input.pin;
    const entry = policy.catalog.find((e) => same(e, target));
    return {
      source: "pin",
      ...classified,
      target,
      effort,
      ...(entry && { estimate: { tokens, cost: effectiveCost(entry, tokens, input), switchCost: 0 } }),
      reason: `You pinned ${describe(target, effort)}.`,
      trace: [{ stage: "pin", note: `pinned ${target.harness} · ${target.model} · ${effort}; routing skipped` }, ...signalNotes],
    };
  }

  // Stage 1: candidates and constraints.
  const paths = [...(input.paths ?? []), ...sig.files];
  const restrictions = policy.restrictions.filter((r) => paths.some((p) => new Bun.Glob(r.match).match(p)));
  const cachedTokens = input.current?.cachedTokens ?? 0;
  const unavailable = (t: CatalogEntry) => {
    if (input.harnesses && !input.harnesses.includes(t.harness)) return `the ${t.harness} harness isn't running`;
    const provider = input.providers?.[t.provider];
    if (provider?.healthy === false) return `${t.provider} is unhealthy`;
    if (provider?.remaining !== undefined && provider.remaining <= 0) return `${t.provider} is out of quota`;
    // Headroom so the task has room to work after the context moves over.
    if (t.context < cachedTokens * 1.25) return `its ${kTokens(t.context)} context can't hold ${kTokens(cachedTokens)} of cached context`;
    for (const r of restrictions) {
      if (r.forbid?.includes(t.access)) return `${t.access} is forbidden for ${r.match}`;
      if (r.minTier && rank(t.tier) < rank(r.minTier)) return `tier ${t.tier} is below ${r.minTier} for ${r.match}`;
    }
    return undefined;
  };
  const candidates = new Map<string, CatalogEntry>();
  const dropped = new Map<string, string>();
  for (const [name, t] of policy.targets) {
    const why = unavailable(t);
    if (why) dropped.set(name, why);
    else candidates.set(name, t);
  }
  trace.push({
    stage: "candidates",
    note:
      dropped.size === 0
        ? `all ${candidates.size} targets available`
        : `dropped ${[...dropped].map(([n, why]) => `${n}: ${why}`).join("; ")}`,
  });
  if (candidates.size === 0) throw new RouterError(`No target is available: ${[...dropped].map(([n, why]) => `${n}: ${why}`).join("; ")}.`);
  trace.push(...signalNotes);

  // Stage 4: the cheapest available target the class accepts. If none is left, the cheapest one at
  // least as capable as the weakest it accepts, and failing that the strongest there is.
  const spec = resolveSpec(rule, policy.mode, planning);
  const effort = spec.effort ?? "medium";
  const cost = (t: CatalogEntry) => effectiveCost(t, tokens, input);
  const cheapest = (ts: CatalogEntry[]) => ts.reduce((a, b) => (cost(b) < cost(a) ? b : a));
  const accepted = spec.prefer ?? [];
  const preferred = accepted.flatMap((n) => candidates.get(n) ?? []);
  const floor = Math.min(...accepted.flatMap((n) => policy.targets.get(n) ?? []).map((t) => rank(t.tier)));
  const others = [...candidates.values()];
  const above = others.filter((t) => rank(t.tier) >= floor);
  const strongest = Math.max(...others.map((t) => rank(t.tier)));
  const pick =
    preferred.length > 0 ? cheapest(preferred) : cheapest(above.length > 0 ? above : others.filter((t) => rank(t.tier) === strongest));
  const lead = unsure
    ? `Not sure what kind of task this is (best guess ${c.taskClass}, confidence ${c.confidence.toFixed(2)})`
    : input.planApproved
      ? `The plan for this ${c.taskClass} task is approved`
      : `Looks like ${c.taskClass}${planning ? " in plan mode" : ""}`;
  // Named only when it moved the route off the balanced one, so the reason says why a task ran cheaper or stronger.
  const balanced = resolveSpec(rule, "balanced", planning);
  const byMode = balanced.effort !== spec.effort || balanced.prefer?.join() !== spec.prefer?.join() ? `in ${policy.mode} mode ` : "";
  trace.push({
    stage: "policy",
    note: `${unsure ? "fallback" : c.taskClass}${planning ? " (plan)" : input.planApproved ? " (build after its plan)" : ""} in ${policy.mode} mode accepts ${accepted.join(", ") || "nothing"} at ${effort}; picked ${pick.model}, ~${kTokens(tokens)} tokens for ${dollars(cost(pick))}`,
  });
  let reason =
    preferred.length > 0
      ? `${lead}, so ${unsure ? `it runs on the ${policy.mode} default, ` : `${byMode}it runs on `}${describe(pick, effort)}.`
      : `${lead}, but ${accepted.map((n) => policy.targets.get(n)?.model ?? n).join(" and ")} ${accepted.length === 1 ? "is" : "are"} unavailable, so it runs on ${describe(pick, effort)}, the ${above.length > 0 ? "cheapest capable" : "strongest"} target left.`;

  // Stage 5: switch-cost gate. Leave a warm session only for a more capable target, or when the savings beat re-reading the cached context.
  const current = input.current;
  const currentEntry = current && policy.catalog.find((e) => same(e, current.target));
  let target: CatalogEntry = pick;
  let switchCost = 0;
  if (current && currentEntry && !same(currentEntry, pick)) {
    const why = unavailable(currentEntry);
    const moveCost = effectiveCost(pick, cachedTokens, input, "cacheWrite");
    const savings = cost(currentEntry) - cost(pick);
    if (why) trace.push({ stage: "switch", note: `switch: the warm ${currentEntry.model} session is unavailable (${why})` });
    else if (rank(pick.tier) > rank(currentEntry.tier))
      trace.push({ stage: "switch", note: `switch: ${pick.model} is more capable than the warm ${currentEntry.model}` });
    else if (savings > moveCost)
      trace.push({
        stage: "switch",
        note: `switch: saves ${dollars(savings)}, more than the ${dollars(moveCost)} to move ${kTokens(cachedTokens)} of context`,
      });
    else {
      trace.push({
        stage: "switch",
        note: `stay: saves ${dollars(savings)}, less than the ${dollars(moveCost)} to move ${kTokens(cachedTokens)} of context`,
      });
      reason = `${lead}, which would run on ${pick.model}, but it stays on the warm ${currentEntry.model} session at ${effort} effort: switching would cost ${dollars(moveCost)} to save ${dollars(savings)}.`;
      target = currentEntry;
    }
    if (target === pick) switchCost = moveCost;
  } else if (current && !currentEntry) {
    trace.push({ stage: "switch", note: `switch: the warm ${current.target.model} session isn't in the catalog, so it can't be priced` });
  }
  // Claude Code rewrites the conversation's cache on an effort change too (ADR 0002).
  if (current && same(current.target, target) && current.effort !== effort) {
    switchCost = effectiveCost(target, cachedTokens, input, "cacheWrite");
    trace.push({
      stage: "switch",
      note: `effort ${current.effort} → ${effort} rewrites ${kTokens(cachedTokens)} of cached context (${dollars(switchCost)})`,
    });
  }

  const { harness, provider, model, access } = target;
  return {
    source: "policy",
    ...classified,
    target: { harness, provider, model, access },
    effort,
    estimate: { tokens, cost: cost(target), switchCost },
    reason,
    trace,
  };
};
