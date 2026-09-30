import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BudgetMode,
  type Catalog,
  type DecisionAnswer,
  describeRouteChange,
  type HarnessId,
  type InteractionMode,
  type Route,
  type RouteDecision,
  type RouteStats,
  type RouteTarget,
} from "@verdandi/contracts";
import { classificationOf, followUpRules, makeDecide, routingQuestions, routingRules, rulesBackend } from "@verdandi/decisions";
import { builtInCatalog, loadPolicy, PolicyError, type ResolvedPolicy, RouterError, route, rules, signals } from "@verdandi/router";
import { fakeCatalog } from "@verdandi/testkit";
import { Effect, Result } from "effect";

/**
 * The decision layer verdandid runs: `rules` for every kind of question (ADR 0009). Routing classification
 * uses the router's keyword rules, which read only the text: the mode picks a class's plan route, not its class.
 */
export const rulesDecide = makeDecide([rulesBackend({ ...routingRules((text) => rules(signals(text, "build"))), ...followUpRules })]);

/** What routing a task needs from outside the database: the policy that applies and the harnesses that run. */
export type RoutingContext = {
  /** The built-in policy with the project's layered on, or why that file can't be used. */
  readonly policy: Result.Result<ResolvedPolicy, string>;
  /** The built-in policy alone: pins still get classified when the project's policy is broken. */
  readonly builtIn: ResolvedPolicy;
  readonly harnesses: readonly HarnessId[];
  /** The project's routing memory, loaded with the thread's state; none means the policy alone decides. */
  readonly memory?: readonly RouteStats[];
};

/**
 * The thread facts routing reads. `cachedTokens` sizes its warm session for the switch-cost gate, and
 * `budgetMode`, the user's pick, replaces the policy's mode when set.
 */
export type RoutingThread = {
  readonly route: Route;
  readonly pinned: boolean;
  readonly budgetMode: BudgetMode | null;
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

/** The decision layer's routing questions for a new task, at the confidence the project's policy asks for. */
export const taskQuestions = (routing: RoutingContext) =>
  routingQuestions(Result.getOrElse(routing.policy, () => routing.builtIn).minConfidence);

/** When the answers hold no classification, the router takes its safe default. */
const unclassified = { taskClass: "chat.general", difficulty: 0, confidence: 0, lowConfidence: true, why: "no classification" } as const;

/**
 * Pure: where the build moves when the user approves `plan`, the plan of the routed task that `task`
 * decided in plan mode (DESIGN §8.2 lever 3): its class's route without the plan-mode override, through
 * the switch-cost gate, on the harness the turn is running on. Undefined when the build stays put: the
 * route is the same, the gate keeps the warm session, the policy is broken, or no target is left.
 */
export const decideExecuteRoute = (
  thread: RoutingThread,
  routing: RoutingContext,
  task: RouteDecision,
  plan: string,
): RouteDecision | undefined => {
  if (thread.pinned || task.source !== "policy" || Result.isFailure(routing.policy)) return undefined;
  const policy = thread.budgetMode ? { ...routing.policy.success, mode: thread.budgetMode } : routing.policy.success;
  const current = { target: targetOf(thread.route, policy.catalog), effort: thread.route.effort };
  const { taskClass, difficulty, confidence } = task;
  const classify = () => ({ taskClass, difficulty, confidence, why: "the task's class, from when it started" });
  try {
    const decision = route(
      {
        text: plan,
        mode: "build",
        planApproved: true,
        // A running turn can't change harness.
        harnesses: [thread.route.harness],
        ...(thread.sessionId === null ? {} : { current: { ...current, cachedTokens: thread.cachedTokens } }),
      },
      policy,
      classify,
    );
    return describeRouteChange(thread.route, routeOf(decision)) === "" ? undefined : decision;
  } catch (e) {
    if (e instanceof RouterError) return undefined;
    throw e;
  }
};

/**
 * Pure: the decision for a new task in `thread` starting with `text`, classified by the decision layer's
 * `answers` to `taskQuestions`. A pinned thread keeps its route (DESIGN §8.4 stage 0); otherwise the
 * router picks, with the thread's warm session for the switch-cost gate.
 */
export const decideRoute = (
  thread: RoutingThread,
  routing: RoutingContext,
  text: string,
  mode: InteractionMode,
  answers: readonly DecisionAnswer[],
): Result.Result<RouteDecision, RoutingFailure> => {
  const classification = classificationOf(answers) ?? unclassified;
  if (Result.isFailure(routing.policy) && !thread.pinned) return Result.fail({ reason: "InvalidPolicy", message: routing.policy.failure });
  const layered = Result.getOrElse(routing.policy, () => routing.builtIn);
  const policy = thread.budgetMode ? { ...layered, mode: thread.budgetMode } : layered;
  const current = { target: targetOf(thread.route, policy.catalog), effort: thread.route.effort };
  try {
    return Result.succeed(
      route(
        {
          text,
          mode,
          harnesses: routing.harnesses,
          ...(routing.memory ? { memory: routing.memory } : {}),
          ...(thread.pinned ? { pin: current } : {}),
          ...(thread.sessionId === null ? {} : { current: { ...current, cachedTokens: thread.cachedTokens } }),
        },
        policy,
        () => classification,
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
