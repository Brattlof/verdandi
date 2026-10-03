import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BudgetMode,
  type Catalog,
  type DecisionAnswer,
  decisionKinds,
  describeRouteChange,
  type HarnessId,
  type InteractionMode,
  type Route,
  type RouteDecision,
  type RouteInputs,
  type RouteStats,
  type RouteTarget,
  type SpendCapped,
  type TaskClass,
  type UntrustedInput,
} from "@verdandi/contracts";
import {
  classificationOf,
  followUpRules,
  injectionRules,
  makeDecide,
  reviewRules,
  routingQuestions,
  routingRules,
  rulesBackend,
} from "@verdandi/decisions";
import { nativeCatalog } from "@verdandi/harness-native";
import {
  builtInCatalog,
  deescalate,
  type Escalation,
  escalate,
  loadPolicy,
  PinError,
  PolicyError,
  type ResolvedPolicy,
  RouterError,
  route,
  rules,
  signals,
} from "@verdandi/router";
import { fakeCatalog } from "@verdandi/testkit";
import { Effect, Result } from "effect";

/**
 * The decision layer verdandid runs: `rules` for every kind of question (ADR 0009), injection scanning and whether a
 * finished task is worth a background review included. Routing classification
 * uses the router's keyword rules, which read only the text: the mode picks a class's plan route, not its class.
 */
export const verdandiRules = rulesBackend({
  ...routingRules((text) => rules(signals(text, "build"))),
  ...followUpRules,
  ...injectionRules,
  ...reviewRules,
});
export const rulesDecide = makeDecide([verdandiRules]);

/** What routing a task needs from outside the database: the policy that applies and the harnesses that run. */
export type RoutingContext = {
  /** The built-in policy with the project's layered on, or why that file can't be used. */
  readonly policy: Result.Result<ResolvedPolicy, string>;
  /** The built-in policy alone: pins still get classified when the project's policy is broken. */
  readonly builtIn: ResolvedPolicy;
  readonly harnesses: readonly HarnessId[];
  /** The project's routing memory, loaded with the thread's state; none means the policy alone decides. */
  readonly memory?: readonly RouteStats[];
  /** A reached metered spend cap over the thread: the router leaves targets that would spend metered dollars out. */
  readonly capped?: SpendCapped;
};

/**
 * The thread facts routing reads. `cachedTokens` sizes its warm session for the switch-cost gate,
 * `budgetMode`, the user's pick, replaces the policy's mode when set, and `untrusted`, what the warm session
 * read that it could do harm with, holds its route at the policy's floor (DESIGN §17).
 */
export type RoutingThread = {
  readonly route: Route;
  readonly pinned: boolean;
  readonly budgetMode: BudgetMode | null;
  readonly sessionId: string | null;
  readonly cachedTokens: number;
  readonly untrusted: UntrustedInput | null;
};

/** What `decideRoute` reads about the thread and the running verdandid, recorded on `task.started` for offline replay. */
export const routeInputs = (thread: RoutingThread, routing: RoutingContext): RouteInputs => ({
  route: thread.route,
  pinned: thread.pinned,
  budgetMode: thread.budgetMode,
  warm: thread.sessionId !== null,
  cachedTokens: thread.cachedTokens,
  harnesses: routing.harnesses,
  ...(routing.memory && { memory: routing.memory }),
  ...(routing.capped && { capped: routing.capped }),
  ...(thread.untrusted && { untrusted: thread.untrusted }),
});

/** The inverse of `routeInputs`: the thread and routing context a recorded task was decided with, under `policy` now. */
export const replayed = (
  inputs: RouteInputs,
  policy: Pick<RoutingContext, "policy" | "builtIn">,
): { readonly thread: RoutingThread; readonly routing: RoutingContext } => ({
  thread: {
    route: inputs.route,
    pinned: inputs.pinned,
    budgetMode: inputs.budgetMode,
    sessionId: inputs.warm ? "recorded session" : null,
    cachedTokens: inputs.cachedTokens,
    untrusted: inputs.untrusted ?? null,
  },
  routing: {
    ...policy,
    harnesses: inputs.harnesses,
    ...(inputs.memory && { memory: inputs.memory }),
    ...(inputs.capped && { capped: inputs.capped }),
  },
});

export type RoutingFailure = { readonly reason: "InvalidPolicy" | "NoRoute" | "InvalidPin"; readonly message: string };

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

/** The catalog of the harnesses verdandid runs: the native and fake harnesses' models join it while they run. */
export const catalogFor = (harnesses: Partial<Record<HarnessId, unknown>>): Catalog => [
  ...builtInCatalog,
  ...(harnesses.native ? nativeCatalog : []),
  ...(harnesses.fake ? fakeCatalog : []),
];

/** Routing over the harnesses verdandid runs. */
export const routingFor = (harnesses: Partial<Record<HarnessId, unknown>>) =>
  projectRouting(Object.keys(harnesses) as HarnessId[], catalogFor(harnesses));

/** The subagent routes a warm session started with, which it keeps. */
const warmSubagents = (thread: RoutingThread) => (thread.route.subagents ? { subagents: thread.route.subagents } : {});

/** The untrusted input a warm session holds, which floors any route that keeps it (DESIGN §17). */
const warmUntrusted = (thread: RoutingThread) => (thread.sessionId !== null && thread.untrusted ? { untrusted: thread.untrusted } : {});

/** The catalog's target for a route. A model it doesn't know keeps its harness's provider and access mode. */
export const targetOf = (r: Route, catalog: Catalog): RouteTarget => {
  const entry = catalog.find((e) => e.harness === r.harness && e.model === r.model) ?? catalog.find((e) => e.harness === r.harness);
  return { harness: r.harness, provider: entry?.provider ?? r.harness, model: r.model, access: entry?.access ?? "local" };
};

export const routeOf = (d: RouteDecision): Route => ({
  harness: d.target.harness,
  model: d.target.model,
  effort: d.effort,
  ...(d.subagents && { subagents: d.subagents }),
});

/** The decision layer's routing questions for a new task, at the confidence the project's policy asks for. */
export const taskQuestions = (routing: RoutingContext) =>
  routingQuestions(Result.getOrElse(routing.policy, () => routing.builtIn).minConfidence);

const known = (taskClass: TaskClass, why: string): DecisionAnswer => ({
  type: "choice",
  kind: decisionKinds.taskClass,
  answer: taskClass,
  probabilities: { [taskClass]: 1 },
  confidence: 1,
  lowConfidence: false,
  backend: "verdandi",
  why,
});

/**
 * An auxiliary thread's class, which Verdandi knows without asking: a background review's (DESIGN §14.5) or a
 * handoff's (§8.2 lever 5). Given to the router in place of the decision layer's answers, never recorded as one.
 */
export const auxClassification = {
  "review.started": known("aux.review", "a background review of a finished task"),
  "handoff.started": known("aux.handoff", "a handoff summary of a thread moving to another harness"),
} satisfies Record<"review.started" | "handoff.started", DecisionAnswer>;

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
        ...(routing.capped ? { capped: routing.capped } : {}),
        ...(thread.sessionId === null ? {} : { current: { ...current, cachedTokens: thread.cachedTokens, ...warmSubagents(thread) } }),
        ...warmUntrusted(thread),
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
 * Pure: the decision for a new task in `thread` starting with `text` and `images` attached images, classified
 * by the decision layer's `answers` to `taskQuestions`. `at`, the model the message named with a leading `@name`
 * (stripped from `text`), pins the task to it; a pinned thread keeps its route (DESIGN §8.4 stage 0); otherwise
 * the router picks, with the thread's warm session for the switch-cost gate, among the targets a reached spend
 * cap leaves.
 */
export const decideRoute = (
  thread: RoutingThread,
  routing: RoutingContext,
  text: string,
  mode: InteractionMode,
  answers: readonly DecisionAnswer[],
  images = 0,
  at?: string,
): Result.Result<RouteDecision, RoutingFailure> => {
  const classification = classificationOf(answers) ?? unclassified;
  if (Result.isFailure(routing.policy) && !thread.pinned && at === undefined)
    return Result.fail({ reason: "InvalidPolicy", message: routing.policy.failure });
  const layered = Result.getOrElse(routing.policy, () => routing.builtIn);
  const policy = thread.budgetMode ? { ...layered, mode: thread.budgetMode } : layered;
  const current = { target: targetOf(thread.route, policy.catalog), effort: thread.route.effort };
  try {
    return Result.succeed(
      route(
        {
          text,
          mode,
          ...(images > 0 && { images }),
          harnesses: routing.harnesses,
          ...(routing.memory ? { memory: routing.memory } : {}),
          ...(routing.capped ? { capped: routing.capped } : {}),
          ...(thread.pinned ? { pin: current } : {}),
          ...(at === undefined ? {} : { at }),
          ...(thread.sessionId === null ? {} : { current: { ...current, cachedTokens: thread.cachedTokens, ...warmSubagents(thread) } }),
          ...warmUntrusted(thread),
        },
        policy,
        () => classification,
      ),
    );
  } catch (e) {
    if (e instanceof PinError) return Result.fail({ reason: "InvalidPin", message: e.message });
    if (!(e instanceof RouterError)) throw e;
    return Result.fail({
      reason: "NoRoute",
      message: `${e.message} Pick a route for this thread, or add an available target to .verdandi/routing.yaml.`,
    });
  }
};

/**
 * Pure: where the rest of routed task `task` moves when its last turn passed its verifiers and the next one, `text`
 * classified by the decision layer's `answers`, is mechanical work (DESIGN §8.7): a cheaper model on the same harness,
 * through the switch-cost gate. Undefined when the route stays: the thread or task is pinned, the policy is broken, the
 * turn isn't mechanical, the gate keeps the warm session, or no target is left.
 */
export const decideDeescalation = (
  thread: RoutingThread,
  routing: RoutingContext,
  task: RouteDecision | null,
  text: string,
  answers: readonly DecisionAnswer[],
): RouteDecision | undefined => {
  const classification = classificationOf(answers);
  if (thread.pinned || task?.source === "pin" || !classification || Result.isFailure(routing.policy)) return undefined;
  const policy = thread.budgetMode ? { ...routing.policy.success, mode: thread.budgetMode } : routing.policy.success;
  const target = targetOf(thread.route, policy.catalog);
  // Without a session there's no cached context to move.
  const cachedTokens = thread.sessionId === null ? 0 : thread.cachedTokens;
  try {
    const decision = deescalate(
      {
        text,
        current: { target, effort: thread.route.effort, cachedTokens, ...warmSubagents(thread) },
        ...(routing.capped ? { capped: routing.capped } : {}),
        ...warmUntrusted(thread),
      },
      policy,
      () => classification,
    );
    return decision && describeRouteChange(thread.route, routeOf(decision)) !== "" ? decision : undefined;
  } catch (e) {
    if (e instanceof RouterError) return undefined;
    throw e;
  }
};

/**
 * Pure: the escalation ladder's next step for a routed task in `thread` that has taken `escalations` steps, after
 * `failure` (DESIGN §8.7). A broken policy asks, naming the fault, so every escalation is decided and recorded.
 */
export const decideEscalation = (thread: RoutingThread, routing: RoutingContext, escalations: number, failure: string): Escalation => {
  if (Result.isFailure(routing.policy))
    return { step: "ask", reason: `${failure}, and Verdandi didn't escalate: ${routing.policy.failure}` };
  const policy = thread.budgetMode ? { ...routing.policy.success, mode: thread.budgetMode } : routing.policy.success;
  const target = targetOf(thread.route, policy.catalog);
  return escalate({ target, effort: thread.route.effort, escalations, failure, harnesses: routing.harnesses }, policy);
};
