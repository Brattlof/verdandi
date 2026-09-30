import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Catalog, HarnessId, InteractionMode, Route, RouteDecision, RouteTarget } from "@verdandi/contracts";
import { builtInCatalog, loadPolicy, PolicyError, type ResolvedPolicy, RouterError, route, rules } from "@verdandi/router";
import { fakeCatalog } from "@verdandi/testkit";
import { Effect, Result } from "effect";

/** What routing a task needs from outside the database: the policy that applies and the harnesses that run. */
export type RoutingContext = {
  /** The built-in policy with the project's layered on, or why that file can't be used. */
  readonly policy: Result.Result<ResolvedPolicy, string>;
  /** The built-in policy alone: pins still get classified when the project's policy is broken. */
  readonly builtIn: ResolvedPolicy;
  readonly harnesses: readonly HarnessId[];
};

/** The thread facts routing reads. `cachedTokens` sizes its warm session for the switch-cost gate. */
export type RoutingThread = {
  readonly route: Route;
  readonly pinned: boolean;
  readonly sessionId: string | null;
  readonly cachedTokens: number;
};

export type RoutingFailure = { readonly reason: "InvalidPolicy" | "NoRoute"; readonly message: string };

/** Where a project keeps its routing policy (DESIGN §8.6). */
export const policyFile = (projectPath: string) => join(projectPath, ".verdandi", "routing.yaml");

/**
 * Reads the project's `.verdandi/routing.yaml` on each call, so an edit applies to the next task.
 * A missing file means the built-in policy; a broken one is reported naming the file and the key.
 */
export const projectRouting =
  (harnesses: readonly HarnessId[], catalog: Catalog) =>
  (projectPath: string): Effect.Effect<RoutingContext> =>
    Effect.sync(() => {
      const builtIn = loadPolicy([], catalog);
      const file = policyFile(projectPath);
      if (!existsSync(file)) return { policy: Result.succeed(builtIn), builtIn, harnesses };
      try {
        const data = Bun.YAML.parse(readFileSync(file, "utf8"));
        return { policy: Result.succeed(loadPolicy([{ source: file, data }], catalog)), builtIn, harnesses };
      } catch (e) {
        const message = e instanceof PolicyError ? e.message : `${file}: ${e instanceof Error ? e.message : String(e)}`;
        return { policy: Result.fail(`${message}\nFix the file, or delete it to use the built-in policy.`), builtIn, harnesses };
      }
    });

/** Routing over the harnesses verdandid runs; the fake harness's models join the catalog when it runs. */
export const routingFor = (harnesses: Partial<Record<HarnessId, unknown>>) =>
  projectRouting(Object.keys(harnesses) as HarnessId[], harnesses.fake ? [...builtInCatalog, ...fakeCatalog] : builtInCatalog);

/** The catalog's target for a route. A model it doesn't know keeps its harness's provider and access mode. */
const targetOf = (r: Route, catalog: Catalog): RouteTarget => {
  const entry = catalog.find((e) => e.harness === r.harness && e.model === r.model) ?? catalog.find((e) => e.harness === r.harness);
  return { harness: r.harness, provider: entry?.provider ?? r.harness, model: r.model, access: entry?.access ?? "local" };
};

export const routeOf = (d: RouteDecision): Route => ({ harness: d.target.harness, model: d.target.model, effort: d.effort });

/**
 * Pure: the decision for a new task in `thread` starting with `text`. A pinned thread keeps its route
 * (DESIGN §8.4 stage 0); otherwise the router picks, with the thread's warm session for the switch-cost gate.
 */
export const decideRoute = (
  thread: RoutingThread,
  routing: RoutingContext,
  text: string,
  mode: InteractionMode,
): Result.Result<RouteDecision, RoutingFailure> => {
  if (Result.isFailure(routing.policy) && !thread.pinned) return Result.fail({ reason: "InvalidPolicy", message: routing.policy.failure });
  const policy = Result.getOrElse(routing.policy, () => routing.builtIn);
  const current = { target: targetOf(thread.route, policy.catalog), effort: thread.route.effort };
  try {
    return Result.succeed(
      route(
        {
          text,
          mode,
          harnesses: routing.harnesses,
          ...(thread.pinned ? { pin: current } : {}),
          ...(thread.sessionId === null ? {} : { current: { ...current, cachedTokens: thread.cachedTokens } }),
        },
        policy,
        rules,
      ),
    );
  } catch (e) {
    if (!(e instanceof RouterError)) throw e;
    return Result.fail({
      reason: "NoRoute",
      message: `${e.message} Pick a route for this thread, or add an available target to .verdandi/routing.yaml.`,
    });
  }
};
