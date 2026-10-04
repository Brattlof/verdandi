import {
  type BudgetMode,
  type Catalog,
  type CatalogEntry,
  decodePolicy,
  Effort,
  type EscalationStep,
  type Policy,
  type RouteRule,
  type RouteSpec,
  Tier,
} from "@verdandi/contracts";
import { builtInCatalog } from "./catalog.ts";
import builtInPolicy from "./policy.json";

/** Bad routing policy. The message names the file, the key, and what was expected there. */
export class PolicyError extends Error {
  override name = "PolicyError";
}

export type PolicyLayer = { readonly source: string; readonly data: unknown };

type Floor = NonNullable<Policy["untrusted"]>;

export type ResolvedPolicy = {
  readonly mode: BudgetMode;
  readonly minConfidence: number;
  readonly memory: NonNullable<Policy["memory"]>;
  /** Named targets with their catalog entries, in policy order. */
  readonly targets: ReadonlyMap<string, CatalogEntry>;
  readonly routes: NonNullable<Policy["routes"]>;
  readonly fallback: RouteRule;
  readonly restrictions: NonNullable<Policy["restrictions"]>;
  /** The floor for a warm session that holds untrusted input and can do harm with it (DESIGN §17). */
  readonly untrusted: NonNullable<Policy["untrusted"]>;
  /** Commands that check a task's work, run in order after a turn that changed files (DESIGN §8.7). */
  readonly verifiers: readonly string[];
  /**
   * What a routed task tries when a trigger fires, how many steps it takes before asking the user, and how many times the
   * same tool error comes back before that's a trigger, 0 never (DESIGN §8.7).
   */
  readonly escalation: { readonly ladder: readonly EscalationStep[]; readonly maxAutoEscalations: number; readonly repeatedErrors: number };
  /** How many delegated child sessions of a turn run at once, and how deep they nest, 0 none (DESIGN §9.4). */
  readonly delegation: { readonly maxConcurrent: number; readonly maxDepth: number };
  readonly catalog: Catalog;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Objects merge key by key; anything else from `b` replaces `a`. */
const merge = (a: unknown, b: unknown): unknown =>
  isObject(a) && isObject(b)
    ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, k in b ? merge(a[k], b[k]) : a[k]]))
    : b;

const specs = (path: string, rule: RouteRule | undefined) =>
  rule
    ? ([
        [path, rule],
        [`${path}.thrifty`, rule.thrifty],
        [`${path}.max`, rule.max],
        [`${path}.plan`, rule.plan],
        [`${path}.plan.thrifty`, rule.plan?.thrifty],
        [`${path}.plan.max`, rule.plan?.max],
        ...Object.entries(rule.subagents ?? {}).map(([profile, spec]) => [`${path}.subagents.${profile}`, spec] as const),
      ] as const)
    : [];

/** Every `prefer` list in a layer, with its key path for error messages. */
const preferLists = (layer: Policy) =>
  [
    ...Object.entries(layer.routes ?? {}).flatMap(([cls, rule]) => specs(`routes.${cls}`, rule)),
    ...specs("fallback", layer.fallback),
  ].flatMap(([path, spec]) => (spec?.prefer ? [[`${path}.prefer`, spec.prefer] as const] : []));

const level = (e: Effort) => Effort.literals.indexOf(e);

/**
 * `effort` if `efforts`, a model's levels, has it, else the nearest one it has: the highest below, failing that the
 * lowest above. Undefined for a model without effort levels, whose harness ignores the effort.
 */
export const clampEffort = (efforts: readonly Effort[], effort: Effort): Effort | undefined =>
  efforts.includes(effort) ? effort : (efforts.findLast((e) => level(e) < level(effort)) ?? efforts.find((e) => level(e) > level(effort)));

/**
 * A class's route in a budget mode: the balanced route, then the mode's changes, then the plan-phase override and its
 * mode changes. `preferKey` and `effortKey` are the policy keys under `path` the values came from.
 */
export const resolveSpec = (rule: RouteRule, mode: BudgetMode, planning: boolean, path = "") => {
  const layers: (readonly [string, RouteSpec | undefined])[] = [[path, rule]];
  if (mode !== "balanced") layers.push([`${path}.${mode}`, rule[mode]]);
  if (planning)
    layers.push([`${path}.plan`, rule.plan], ...(mode !== "balanced" ? [[`${path}.plan.${mode}`, rule.plan?.[mode]] as const] : []));
  const prefer = layers.findLast(([, s]) => s?.prefer);
  const effort = layers.findLast(([, s]) => s?.effort);
  return {
    ...(prefer?.[1]?.prefer && { prefer: prefer[1].prefer, preferKey: `${prefer[0]}.prefer` }),
    ...(effort?.[1]?.effort && { effort: effort[1].effort, effortKey: `${effort[0]}.effort` }),
  };
};

/**
 * The first effort the merged policy asks of a target whose model doesn't take it, as a message naming the key, or
 * undefined. A model without effort levels ignores any effort, so it never conflicts.
 */
const effortConflict = (merged: Policy, catalog: Catalog) => {
  const entryOf = (name: string) => {
    const t = merged.targets?.[name];
    return t && catalog.find((e) => e.harness === t.harness && e.provider === t.provider && e.model === t.model);
  };
  const rules = [
    ...Object.entries(merged.routes ?? {}).map(([cls, r]) => [`routes.${cls}`, r] as const),
    ["fallback", merged.fallback] as const,
  ];
  for (const [path, rule] of rules) {
    if (!rule) continue;
    const specs = (["thrifty", "balanced", "max"] as const).flatMap((mode) =>
      [false, true].map((plan) => resolveSpec(rule, mode, plan, path)),
    );
    const subagents = Object.entries(rule.subagents ?? {}).map(([profile, spec]) => {
      const key = `${path}.subagents.${profile}`;
      return { ...spec, preferKey: `${key}.prefer`, effortKey: `${key}.effort` };
    });
    for (const { prefer, preferKey, effort, effortKey } of [...specs, ...subagents]) {
      if (!effort) continue;
      for (const name of prefer ?? []) {
        const entry = entryOf(name);
        if (entry && entry.efforts.length > 0 && !entry.efforts.includes(effort))
          return `${effortKey}: ${effort} isn't an effort level of ${entry.model} (${name}, from ${preferKey}), which takes ${entry.efforts.join(", ")}. Pick one of those, or another target.`;
      }
    }
  }
  return undefined;
};

const tiers = Tier.literals;

/** The stricter of two floors: the higher tier, and every access mode either forbids. */
const strictest = (a: Floor | undefined, b: Floor | undefined): Floor | undefined => {
  if (!a || !b) return a ?? b;
  const minTier = [a.minTier, b.minTier].reduce<Tier | undefined>(
    (top, t) => (t && (!top || tiers.indexOf(t) > tiers.indexOf(top)) ? t : top),
    undefined,
  );
  const forbid = [...new Set([...(a.forbid ?? []), ...(b.forbid ?? [])])];
  return { ...(minTier && { minTier }), ...(forbid.length > 0 && { forbid }) };
};

/**
 * The built-in policy with `layers` merged over it in order (profile, then project: DESIGN §8.6).
 * `data` is the parsed file, e.g. `Bun.YAML.parse` of `.verdandi/routing.yaml`. Restrictions and the
 * untrusted-input floor add up across layers instead of replacing each other, so a later layer, such
 * as a cloned repository's, can't lift an earlier one's.
 * Throws a `PolicyError` naming the layer's `source` and the bad key.
 */
export const loadPolicy = (layers: readonly PolicyLayer[] = [], catalog: Catalog = builtInCatalog): ResolvedPolicy => {
  let merged: Policy = {};
  for (const { source, data } of [{ source: "built-in policy", data: builtInPolicy }, ...layers]) {
    let layer: Policy;
    try {
      layer = decodePolicy(data);
    } catch (e) {
      throw new PolicyError(`${source}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const restrictions = [...(merged.restrictions ?? []), ...(layer.restrictions ?? [])];
    const untrusted = strictest(merged.untrusted, layer.untrusted);
    merged = decodePolicy(merge(merged, { ...layer, ...(restrictions.length > 0 && { restrictions }), ...(untrusted && { untrusted }) }));
    for (const [name, t] of Object.entries(layer.targets ?? {})) {
      if (!catalog.some((e) => e.harness === t.harness && e.provider === t.provider && e.model === t.model))
        throw new PolicyError(
          `${source}: targets.${name}: model ${t.model} from ${t.provider} on ${t.harness} isn't in the model catalog.`,
        );
    }
    for (const [path, names] of preferLists(layer)) {
      const unknown = names.find((n) => !merged.targets?.[n]);
      if (unknown) throw new PolicyError(`${source}: ${path}: unknown target "${unknown}"; define it under targets.`);
    }
    const conflict = effortConflict(merged, catalog);
    if (conflict) throw new PolicyError(`${source}: ${conflict}`);
  }
  const targets = new Map(
    Object.entries(merged.targets ?? {}).flatMap(([name, t]) => {
      const entry = catalog.find((e) => e.harness === t.harness && e.provider === t.provider && e.model === t.model);
      return entry ? [[name, entry] as const] : [];
    }),
  );
  return {
    mode: merged.mode ?? "balanced",
    minConfidence: merged.minConfidence ?? 0.6,
    memory: merged.memory ?? { minTasks: 5, minShare: 0.5 },
    targets,
    routes: merged.routes ?? {},
    fallback: merged.fallback ?? {},
    restrictions: merged.restrictions ?? [],
    untrusted: merged.untrusted ?? {},
    verifiers: merged.escalation?.verifiers ?? [],
    escalation: {
      ladder: merged.escalation?.ladder ?? ["effort", "model", "ask"],
      maxAutoEscalations: merged.escalation?.maxAutoEscalations ?? 1,
      repeatedErrors: merged.escalation?.repeatedErrors ?? 3,
    },
    delegation: { maxConcurrent: merged.delegation?.maxConcurrent ?? 3, maxDepth: merged.delegation?.maxDepth ?? 1 },
    catalog,
  };
};
