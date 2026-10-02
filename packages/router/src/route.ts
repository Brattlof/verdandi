import {
  type CatalogEntry,
  type Effort,
  type HarnessId,
  type InteractionMode,
  type RouteDecision,
  type RouteRule,
  type RouteStats,
  type RouteTarget,
  type RuleTrace,
  type SpendCapped,
  type SubagentRoutes,
  spendsMetered,
  type Tier,
} from "@verdandi/contracts";
import { clampEffort, type ResolvedPolicy, resolveSpec } from "./policy.ts";
import type { Classifier } from "./rules.ts";
import { describeSignals, signals } from "./signals.ts";

export type Pinned = { readonly target: RouteTarget; readonly effort: Effort };

export type RouteInput = {
  /** The task's first message, without its leading `@name`. */
  readonly text: string;
  readonly mode: InteractionMode;
  /** The thread's pin: the user's pick in the route picker. It wins over everything but `at`. */
  readonly pin?: Pinned;
  /**
   * The model the message named with a leading `@name` (contracts' `atPin`), matched to the catalog's models on `harnesses`
   * ignoring case. It pins this task, over the thread's pin too, at the thread's effort when that's its model, else at
   * the policy's effort for the task's class. A name that isn't one of them throws a `PinError`.
   */
  readonly at?: string;
  /** The thread's warm session, how many tokens of context it has cached, and the subagent routes it started with. */
  readonly current?: Pinned & { readonly cachedTokens: number; readonly subagents?: SubagentRoutes };
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
  /** How many images are attached: only targets that read images stay candidates. */
  readonly images?: number;
  /** The project's routing memory (DESIGN §8.8): how its tasks went, per class and route. Pins ignore it. */
  readonly memory?: readonly RouteStats[];
  /** A reached metered spend cap: targets that would spend metered dollars drop out (DESIGN §8.9). Pins ignore it. */
  readonly capped?: SpendCapped;
};

/** No target is available at all. The message says why each one dropped out. */
export class RouterError extends Error {
  override name = "RouterError";
}

/** An `@name` that isn't a model on a running harness. The message names the ones that are. */
export class PinError extends Error {
  override name = "PinError";
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

const describeSubagents = (routes: SubagentRoutes | undefined) =>
  Object.entries(routes ?? {})
    .map(([profile, r]) => `${profile} on ${r?.model} at ${r?.effort}`)
    .join(", ") || "none";

/**
 * After stage 5 (DESIGN §8.2 lever 1): the task's subagent routes, on the harness of its main `target`. A warm session on that harness
 * keeps the ones it started with, since a harness fixes its agent list for the session (and Claude Code's
 * sits in the cached prompt); a fresh one takes the rule's, each the cheapest available target it prefers.
 */
const routeSubagents = (
  input: RouteInput,
  rule: RouteRule,
  target: RouteTarget,
  effort: Effort,
  candidates: ReadonlyMap<string, CatalogEntry>,
  cost: (t: CatalogEntry) => number,
): { readonly subagents?: SubagentRoutes; readonly trace?: RuleTrace } => {
  const current = input.current;
  if (current?.target.harness === target.harness) {
    const kept = current.subagents;
    return {
      ...(kept && { subagents: kept }),
      ...((kept || rule.subagents) && {
        trace: { stage: "subagents", note: `kept the warm session's: ${describeSubagents(kept)}; a session's subagents are fixed` },
      }),
    };
  }
  const specs = Object.entries(rule.subagents ?? {});
  if (specs.length === 0) return {};
  const picked: Record<string, { model: string; effort: Effort }> = {};
  const missing: string[] = [];
  for (const [profile, spec] of specs) {
    const options = (spec?.prefer ?? []).flatMap((n) => candidates.get(n) ?? []).filter((t) => t.harness === target.harness);
    const best = options.length > 0 ? options.reduce((a, b) => (cost(b) < cost(a) ? b : a)) : undefined;
    const wanted = spec?.effort ?? effort;
    if (best) picked[profile] = { model: best.model, effort: clampEffort(best.efforts, wanted) ?? wanted };
    else missing.push(`${profile}: none of ${spec?.prefer?.join(", ") || "its targets"} is available on ${target.harness}`);
  }
  const subagents = picked as SubagentRoutes;
  const note = `${describeSubagents(subagents)}${missing.length > 0 ? `; ${missing.join("; ")}, so it keeps the harness default` : ""}`;
  return { ...(Object.keys(picked).length > 0 && { subagents }), trace: { stage: "subagents", note } };
};

const dollars = (n: number) => `$${n < 0.01 ? n.toPrecision(1) : n.toFixed(2)}`;
const kTokens = (n: number) => `${Math.round(n / 1000)}K`;

type Pin = Pinned & { readonly reason: string; readonly note: string };

/**
 * Stage 0 for `@name`: the catalog's model of that name on a running harness. It keeps the effort of the thread's warm
 * session or pin when that's on the same model, since an effort change rewrites the cache (ADR 0002), and otherwise
 * takes `policy`, the effort the policy gives the task's class.
 */
const atPinned = (input: RouteInput, name: string, catalog: readonly CatalogEntry[], policy: { effort: Effort; of: string }): Pin => {
  const runnable = catalog.filter((e) => !input.harnesses || input.harnesses.includes(e.harness));
  const entry = runnable.find((e) => e.model.toLowerCase() === name.toLowerCase());
  if (!entry) {
    const names = [...new Set(runnable.map((e) => `@${e.model}`))].join(", ");
    throw new PinError(`@${name} isn't a model Verdandi can run. Use one of ${names}.`);
  }
  const { harness, provider, model, access } = entry;
  const thread = input.current ?? input.pin;
  const kept = thread && same(thread.target, entry) ? thread.effort : undefined;
  const effort = kept ?? policy.effort;
  return {
    target: { harness, provider, model, access },
    effort,
    reason: `Pinned with @${model}.`,
    note: `@${model} pinned ${harness} · ${model} · ${effort}, ${kept ? "the thread's effort on it" : `${policy.of}'s effort`}; routing skipped`,
  };
};

/**
 * Stages 0–5 of the routing pipeline (DESIGN §8.4). Pure: everything it knows comes in through
 * `input` and `policy`, and the classifier is passed in. Throws a `RouterError` only when no
 * target is available at all.
 */
export const route = (input: RouteInput, policy: ResolvedPolicy, classify: Classifier): RouteDecision => {
  const trace: RuleTrace[] = [];
  const effortsOf = (t: RouteTarget) => policy.catalog.find((e) => same(e, t))?.efforts;
  // A model without effort levels ignores the effort, so its reason names none.
  const describe = (t: RouteTarget, effort: Effort) => (effortsOf(t)?.length === 0 ? t.model : `${t.model} at ${effort} effort`);
  /** The effort `t` runs `effort` at: the nearest level its model takes, with a note for `stage` when that moved it. */
  const fit = (t: RouteTarget, effort: Effort, stage: RuleTrace["stage"], notes = trace): Effort => {
    const levels = effortsOf(t) ?? [];
    const to = clampEffort(levels, effort) ?? effort;
    if (to !== effort) notes.push({ stage, note: `${t.model} takes ${levels.join(", ")}, so ${effort} is clamped to ${to}` });
    return to;
  };
  const planning = input.mode === "plan" && !input.planApproved;

  // Stages 2 and 3 run even for pins, so the decision records what the user overrode.
  const sig = signals(input.text, input.mode);
  const c = classify(sig);
  const classified = { taskClass: c.taskClass, difficulty: c.difficulty, confidence: c.confidence };
  const unsure = c.lowConfidence ?? c.confidence < policy.minConfidence;
  const rule = (!unsure && policy.routes[c.taskClass]) || policy.fallback;
  const tokens = rule.tokens ?? policy.fallback.tokens ?? 0;
  // Budget guards apply to pinned tasks too: a pin picks the route, not the budget (DESIGN §8.9).
  const maxCost = rule.maxCost ?? policy.fallback.maxCost;
  const maxTurns = rule.maxTurns ?? policy.fallback.maxTurns;
  const limits =
    maxCost === undefined && maxTurns === undefined ? {} : { limits: { ...(maxCost && { maxCost }), ...(maxTurns && { maxTurns }) } };
  const signalNotes: RuleTrace[] = [
    {
      stage: "signals",
      note: `${describeSignals(sig)}${input.images ? `, ${input.images} image${input.images === 1 ? "" : "s"} attached` : ""}`,
    },
    { stage: "classify", note: `${c.taskClass}, confidence ${c.confidence.toFixed(2)}, difficulty ${c.difficulty.toFixed(2)} (${c.why})` },
  ];

  // Stage 0: the user's choice always wins, whatever the policy says: a model named with `@`, then the thread's pin.
  const of = `${unsure ? "fallback" : c.taskClass}${planning ? " (plan)" : ""} in ${policy.mode} mode`;
  const pin: Pin | undefined =
    input.at !== undefined
      ? atPinned(input, input.at, policy.catalog, { effort: resolveSpec(rule, policy.mode, planning).effort ?? "medium", of })
      : input.pin && {
          ...input.pin,
          reason: `You pinned ${describe(input.pin.target, input.pin.effort)}.`,
          note: `pinned ${input.pin.target.harness} · ${input.pin.target.model} · ${input.pin.effort}; routing skipped`,
        };
  if (pin) {
    const { target } = pin;
    const clamped: RuleTrace[] = [];
    const effort = fit(target, pin.effort, "pin", clamped);
    const entry = policy.catalog.find((e) => same(e, target));
    // The policy's subagents don't apply to a pin; a warm session still keeps its own.
    const sub = routeSubagents(input, {}, target, effort, new Map(), () => 0);
    return {
      source: "pin",
      ...classified,
      target,
      effort,
      ...(sub.subagents && { subagents: sub.subagents }),
      ...(entry && { estimate: { tokens, cost: effectiveCost(entry, tokens, input), switchCost: 0 } }),
      reason: effort === pin.effort ? pin.reason : `${pin.reason.slice(0, -1)}, which it doesn't take, so it runs at ${effort}.`,
      trace: [{ stage: "pin", note: pin.note }, ...clamped, ...signalNotes, ...(sub.trace ? [sub.trace] : [])],
      ...limits,
    };
  }

  // Stage 1: candidates and constraints.
  const paths = [...(input.paths ?? []), ...sig.files];
  const restrictions = policy.restrictions.filter((r) => paths.some((p) => new Bun.Glob(r.match).match(p)));
  const cachedTokens = input.current?.cachedTokens ?? 0;
  const capped = input.capped && `the ${input.capped.cap} of metered spend is reached`;
  const unavailable = (t: CatalogEntry) => {
    if (input.harnesses && !input.harnesses.includes(t.harness)) return `the ${t.harness} harness isn't running`;
    if (input.images && !t.vision) return `it can't read the attached image${input.images === 1 ? "" : "s"}`;
    if (capped && spendsMetered(t, input.capped?.paying ?? [])) return capped;
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
  let effort = spec.effort ?? "medium";
  const cost = (t: CatalogEntry) => effectiveCost(t, tokens, input);
  const cheapest = (ts: CatalogEntry[]) => ts.reduce((a, b) => (cost(b) < cost(a) ? b : a));
  const accepted = spec.prefer ?? [];
  const preferred = accepted.flatMap((n) => candidates.get(n) ?? []);
  const floor = Math.min(...accepted.flatMap((n) => policy.targets.get(n) ?? []).map((t) => rank(t.tier)));
  const others = [...candidates.values()];
  const above = others.filter((t) => rank(t.tier) >= floor);
  const strongest = Math.max(...others.map((t) => rank(t.tier)));
  let pick =
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
  effort = fit(pick, effort, "policy");
  // The cap moved the task when, without it, the class would have run on a target the cap dropped.
  const skipped = capped ? accepted.flatMap((n) => (dropped.get(n) === capped ? (policy.targets.get(n) ?? []) : [])) : [];
  const instead = skipped.length > 0 ? cheapest([...preferred, ...skipped]) : undefined;
  let reason =
    instead && skipped.includes(instead)
      ? `${lead}, but ${capped}, so it runs on ${describe(pick, effort)} instead of ${instead.access === "metered" ? `the metered ${instead.model}` : `${instead.model} on extra usage`}.`
      : preferred.length > 0
        ? `${lead}, so ${unsure ? `it runs on the ${policy.mode} default, ` : `${byMode}it runs on `}${describe(pick, effort)}.`
        : `${lead}, but ${accepted.map((n) => policy.targets.get(n)?.model ?? n).join(" and ")} ${accepted.length === 1 ? "is" : "are"} unavailable, so it runs on ${describe(pick, effort)}, the ${above.length > 0 ? "cheapest capable" : "strongest"} target left.`;

  // Stage 4, continued: routing memory. How this project's tasks of the class went on the policy's route
  // can move it: to where the user kept moving them, or else one tier up from where they kept failing.
  const memory =
    unsure || input.planApproved
      ? undefined
      : input.memory?.find(
          (s) =>
            s.taskClass === c.taskClass && s.route.harness === pick.harness && s.route.model === pick.model && s.route.effort === effort,
        );
  let remembered = false;
  const moved: RuleTrace[] = [];
  if (memory) {
    const { minTasks, minShare } = policy.memory;
    const n = memory.tasks;
    const top = memory.overrides[0];
    const failures = memory.failed + memory.escalated + memory.reverted;
    const counts = `${n} ${c.taskClass} task${n === 1 ? "" : "s"} on ${describe(pick, effort)}: ${memory.completed} completed, ${failures} failed, escalated, reverted or rated down, ${top?.count ?? 0} moved by you`;
    let move: { readonly to: CatalogEntry; readonly effort: Effort; readonly why: string } | undefined;
    let note = `${counts}; `;
    if (n < minTasks) note += `too few to act on (minTasks ${minTasks})`;
    else if (top && top.count / n >= minShare) {
      const to = policy.catalog.find((e) => e.harness === top.to.harness && e.model === top.to.model);
      const why = to ? unavailable(to) : `${top.to.model} isn't in the catalog`;
      // An effort-only move names the effort it moved off.
      const off = to?.model === pick.model ? describe(pick, effort) : pick.model;
      if (to && !why) {
        const e = fit(to, top.to.effort, "memory", moved);
        move = {
          to,
          effort: e,
          why: `${c.taskClass} tasks here were moved off ${off} by you ${top.count} of ${n} times, so it starts on ${describe(to, e)}.`,
        };
      } else note += `you moved most to ${top.to.model} at ${top.to.effort} effort, but ${why}`;
    } else if (failures / n >= minShare) {
      const stronger = others.filter((t) => rank(t.tier) > rank(pick.tier));
      if (stronger.length > 0) {
        const to = cheapest(stronger);
        const e = fit(to, effort, "memory", moved);
        move = {
          to,
          effort: e,
          why: `${c.taskClass} tasks here didn't succeed on ${pick.model} ${failures} of ${n} times, so it starts on the stronger ${describe(to, e)}.`,
        };
      } else note += "most didn't succeed, but no stronger target is available";
    } else note += `below the ${minShare} share that moves it`;
    if (move) {
      note += `moved to ${move.to.model} at ${move.effort}`;
      pick = move.to;
      effort = move.effort;
      reason = move.why;
      remembered = true;
    }
    trace.push({ stage: "memory", note }, ...moved);
  }

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
      effort = fit(currentEntry, effort, "switch");
      reason = `${lead}, which would run on ${pick.model}, but it stays on the warm ${currentEntry.model} session${currentEntry.efforts.length === 0 ? "" : ` at ${effort} effort`}: switching would cost ${dollars(moveCost)} to save ${dollars(savings)}.`;
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
  const sub = routeSubagents(input, rule, target, effort, candidates, cost);
  if (sub.trace) trace.push(sub.trace);
  return {
    source: remembered && target === pick ? "memory" : "policy",
    ...(memory && { memory }),
    ...classified,
    target: { harness, provider, model, access },
    effort,
    ...(sub.subagents && { subagents: sub.subagents }),
    estimate: { tokens, cost: cost(target), switchCost },
    reason,
    trace,
    ...limits,
  };
};
