import {
  type BudgetMode,
  type Catalog,
  type CatalogEntry,
  decodeCatalog,
  decodePolicy,
  type Policy,
  type RouteRule,
} from "@verdandi/contracts";
import catalogData from "./catalog.json";
import builtInPolicy from "./policy.json";

/** Bad routing policy. The message names the file, the key, and what was expected there. */
export class PolicyError extends Error {
  override name = "PolicyError";
}

/** The bundled model catalog (DESIGN §8.6). */
export const builtInCatalog = decodeCatalog(catalogData);

export type PolicyLayer = { readonly source: string; readonly data: unknown };

export type ResolvedPolicy = {
  readonly mode: BudgetMode;
  readonly minConfidence: number;
  readonly memory: NonNullable<Policy["memory"]>;
  /** Named targets with their catalog entries, in policy order. */
  readonly targets: ReadonlyMap<string, CatalogEntry>;
  readonly routes: NonNullable<Policy["routes"]>;
  readonly fallback: RouteRule;
  readonly restrictions: NonNullable<Policy["restrictions"]>;
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

/**
 * The built-in policy with `layers` merged over it in order (profile, then project: DESIGN §8.6).
 * `data` is the parsed file, e.g. `Bun.YAML.parse` of `.verdandi/routing.yaml`. Restrictions add up
 * across layers instead of replacing each other, so a later layer can't lift an earlier one's.
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
    merged = decodePolicy(merge(merged, restrictions.length > 0 ? { ...layer, restrictions } : layer));
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
    catalog,
  };
};
