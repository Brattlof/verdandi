import { Schema } from "effect";
import { Effort, HarnessId, Route, SubagentProfile, SubagentRoutes } from "./route.ts";

/**
 * The v1 task taxonomy (DESIGN §8.5). A task's class picks its route from the policy. `aux.*` classes are Verdandi's
 * own auxiliary tasks (§9.7), never a user's: `aux.review` is a background review of a finished task (§14.5), and
 * `aux.handoff` writes the summary a thread's new harness session starts from (§8.2 lever 5).
 */
export const TaskClass = Schema.Literals([
  "ask.search",
  "ask.explain",
  "chore.git",
  "docs.write",
  "code.edit.mechanical",
  "code.edit.local",
  "test.write",
  "code.feature",
  "code.refactor.large",
  "debug.investigate",
  "review",
  "design.architecture",
  "chat.general",
  "aux.review",
  "aux.handoff",
]);
export type TaskClass = typeof TaskClass.Type;

/** How far routes move from the balanced table: Thrifty one step down, Max one step up (DESIGN §8.5). */
export const BudgetMode = Schema.Literals(["thrifty", "balanced", "max"]);
export type BudgetMode = typeof BudgetMode.Type;

export const Access = Schema.Literals(["subscription", "metered", "local"]);
export type Access = typeof Access.Type;

/** Model capability tier, S < M < L < XL. A switch to a higher tier always passes the switch-cost gate. */
export const Tier = Schema.Literals(["S", "M", "L", "XL"]);
export type Tier = typeof Tier.Type;

export const RouteTarget = Schema.Struct({ harness: HarnessId, provider: Schema.String, model: Schema.String, access: Access });
export type RouteTarget = typeof RouteTarget.Type;

/** A model's $/MTok list prices. */
export const Price = Schema.Struct({ input: Schema.Number, output: Schema.Number, cacheRead: Schema.Number, cacheWrite: Schema.Number });
export type Price = typeof Price.Type;

/** A list price and the UTC day it took effect, `YYYY-MM-DD`. */
export const DatedPrice = Schema.Struct({ since: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)), ...Price.fields });
export type DatedPrice = typeof DatedPrice.Type;

const catalogModel = {
  ...RouteTarget.fields,
  tier: Tier,
  context: Schema.Int,
  /** Whether it reads images: a task with an image attached routes only to targets that do. */
  vision: Schema.Boolean,
  /**
   * The effort levels it takes. Empty when it has no effort setting, so its harness ignores one
   * (Claude Code reports them as `supportedEffortLevels` from `supportedModels()`).
   */
  efforts: Schema.Array(Effort),
};

/** A model as one harness and provider serve it (DESIGN §8.6), at its latest list price. */
export const CatalogEntry = Schema.Struct({ ...catalogModel, price: Price });
export type CatalogEntry = typeof CatalogEntry.Type;

/**
 * A catalog entry with every list price it has had, oldest first. A price change, or its alias moving to another model,
 * adds one and keeps the old; a wrong price is fixed in place, since it never applied. The router routes on the latest.
 */
export const DatedCatalogEntry = Schema.Struct({ ...catalogModel, prices: Schema.NonEmptyArray(DatedPrice) });
export type DatedCatalogEntry = typeof DatedCatalogEntry.Type;

/** A catalog model as clients offer it: its target and the effort levels it takes. */
export const CatalogModel = Schema.Struct({ ...RouteTarget.fields, efforts: Schema.Array(Effort) });
export type CatalogModel = typeof CatalogModel.Type;

/** What these tokens cost at `price`, a catalog entry's $/MTok list prices. */
export const listCost = (
  price: Price,
  tokens: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
  },
) =>
  (tokens.inputTokens * price.input +
    tokens.outputTokens * price.output +
    tokens.cacheReadTokens * price.cacheRead +
    tokens.cacheWriteTokens * price.cacheWrite) /
  1e6;

export const Catalog = Schema.Array(CatalogEntry);
export type Catalog = typeof Catalog.Type;
/** Decodes the router's `catalog.json`. */
export const decodeDatedCatalog = Schema.decodeUnknownSync(Schema.Array(DatedCatalogEntry));

/**
 * A task's budget guards (DESIGN §8.9): at most `maxCost` USD, and `maxTurns` agent turns (model round trips).
 * A task that reaches one stops, and its turn ends with status `limit`. Turn count is only a guard, never an escalation signal.
 */
export const TaskLimits = Schema.Struct({
  maxCost: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThan(0))),
  maxTurns: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type TaskLimits = typeof TaskLimits.Type;

/**
 * A step of the escalation ladder (DESIGN §8.7): `effort` raises the task's effort one level, `model` moves it to a
 * stronger model on the same harness, `ask` stops and leaves the next move to the user.
 */
export const EscalationStep = Schema.Literals(["effort", "model", "ask"]);
export type EscalationStep = typeof EscalationStep.Type;

/**
 * What set off an escalation (DESIGN §8.7): a project verifier failed, the agent called `report_blocked`, the same
 * tool error came back `escalation.repeatedErrors` times in the task, the decision layer read the user's follow-up
 * as correcting the agent, or the user rejected the agent's plan.
 */
export const EscalationTrigger = Schema.Literals(["verifier", "blocked", "repeated-error", "correction", "plan-rejected"]);
export type EscalationTrigger = typeof EscalationTrigger.Type;

/** A partial route: layers merge key by key, so a later layer can change only the effort. */
export const RouteSpec = Schema.Struct({
  /** Acceptable targets by name; the router picks the cheapest available one, ties going to the earlier. */
  prefer: Schema.optionalKey(Schema.NonEmptyArray(Schema.String)),
  effort: Schema.optionalKey(Effort),
});
export type RouteSpec = typeof RouteSpec.Type;

const PhaseRule = Schema.Struct({ ...RouteSpec.fields, thrifty: Schema.optionalKey(RouteSpec), max: Schema.optionalKey(RouteSpec) });

/** A class's route: balanced by default, per budget mode on top, and a `plan` override for tasks started in plan mode. */
export const RouteRule = Schema.Struct({
  ...PhaseRule.fields,
  plan: Schema.optionalKey(PhaseRule),
  /** Routes for the task's subagents by profile, on the main route's harness (DESIGN §8.2 lever 1). */
  subagents: Schema.optionalKey(Schema.Record(SubagentProfile, Schema.optionalKey(RouteSpec))),
  /** Rough size of a task of this class, for cost estimates and the switch-cost gate. */
  tokens: Schema.optionalKey(Schema.Int),
  /** Budget guards for each task of this class (DESIGN §8.9); `fallback`'s apply to classes that set none. */
  ...TaskLimits.fields,
  /**
   * How many effort levels a turn of this class's tasks may move either side of its route's effort (DESIGN §8.7 auto
   * effort), on a harness that changes effort without a cache miss: default 1, 0 off. `fallback`'s applies to classes
   * that set none.
   */
  effortBand: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))),
});
export type RouteRule = typeof RouteRule.Type;

/** The weakest targets a route may take: none with a forbidden access mode, none below `minTier`. */
const Floor = Schema.Struct({ forbid: Schema.optionalKey(Schema.Array(Access)), minTier: Schema.optionalKey(Tier) });

/**
 * One layer of routing policy (DESIGN §8.6): built-in defaults, then profile, then project
 * (`.verdandi/routing.yaml`). Unknown keys are errors, so a typo never silently does nothing.
 */
export const Policy = Schema.Struct({
  mode: Schema.optionalKey(BudgetMode),
  /** Only `rules` exists today; `decision`, `api` and `learned` come later (DESIGN §8.4). */
  classifier: Schema.optionalKey(Schema.Literal("rules")),
  /** Below this confidence the router uses `fallback`, the budget mode's safe default, instead of guessing. */
  minConfidence: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  targets: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ harness: HarnessId, provider: Schema.String, model: Schema.String })),
  ),
  routes: Schema.optionalKey(Schema.Record(TaskClass, Schema.optionalKey(RouteRule))),
  fallback: Schema.optionalKey(RouteRule),
  /**
   * Routing memory (DESIGN §8.8): once `minTasks` of a class ran on the policy's route in this project, the
   * route moves when at least `minShare` of them were moved elsewhere by the user, or didn't succeed.
   */
  memory: Schema.optionalKey(
    Schema.Struct({
      minTasks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
      minShare: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    }),
  ),
  /**
   * How a task's work is checked (DESIGN §8.7). `verifiers` are shell commands, e.g. `bun test`, run in order in the project
   * folder after a turn whose agent changed files, until one fails. Its exit code says whether the work holds up.
   */
  escalation: Schema.optionalKey(
    Schema.Struct({
      verifiers: Schema.optionalKey(Schema.Array(Schema.String)),
      /** What a routed task tries after a verifier fails, one step per failure (default `[effort, model, ask]`). */
      ladder: Schema.optionalKey(Schema.NonEmptyArray(EscalationStep)),
      /** How many steps a task takes without asking the user (default 1); then it stops and leaves the next one to the user. */
      maxAutoEscalations: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      /** How many times the same tool error (paths, numbers and ids aside) comes back in a task before it escalates (default 3; 0 never). */
      repeatedErrors: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ),
  /** When a task touches a path matching `match` (a glob), drop targets with a forbidden access mode or below `minTier`. */
  restrictions: Schema.optionalKey(Schema.Array(Schema.Struct({ match: Schema.String, ...Floor.fields }))),
  /**
   * While a warm session holds untrusted input (DESIGN §17) and has tools that write files or run commands, no route
   * keeps it on a target with a forbidden access mode or below `minTier`: smaller models are easier to hijack.
   */
  untrusted: Schema.optionalKey(Floor),
  /**
   * The native agent's `delegate_task` (DESIGN §9.4): at most `maxConcurrent` child sessions of one turn run at once,
   * and children nest at most `maxDepth` deep, 0 turning delegation off (built-in: 3 and 1, so a child can't delegate).
   */
  delegation: Schema.optionalKey(
    Schema.Struct({
      maxConcurrent: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }))),
      maxDepth: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
    }),
  ),
});
export type Policy = typeof Policy.Type;

/** Decodes one policy layer. Throws with every problem and its key path, e.g. `at ["routes"]["review"]["effort"]`. */
export const decodePolicy = (data: unknown) => Schema.decodeUnknownSync(Policy)(data, { onExcessProperty: "error", errors: "all" });

/**
 * How a project's tasks of one class went on one route (DESIGN §8.8, routing memory level 1), from their
 * outcomes since the project's routing memory was last cleared.
 */
export const RouteStats = Schema.Struct({
  taskClass: TaskClass,
  route: Route,
  tasks: Schema.Int,
  completed: Schema.Int,
  /** Failed, or ended another way and the user rated it down. */
  failed: Schema.Int,
  escalated: Schema.Int,
  reverted: Schema.Int,
  /** Where the user moved these tasks, most often first. */
  overrides: Schema.Array(Schema.Struct({ to: Route, count: Schema.Int })),
});
export type RouteStats = typeof RouteStats.Type;

/**
 * A reached metered spend cap (DESIGN §8.9). `cap` names it, e.g. `the profile's daily cap`. While it holds, targets
 * that would spend metered dollars are unavailable: metered ones, and any on a harness in `paying`, whose
 * subscription window runs on extra usage (ADR 0005).
 */
export const SpendCapped = Schema.Struct({ cap: Schema.String, paying: Schema.Array(HarnessId) });
export type SpendCapped = typeof SpendCapped.Type;

/** Whether a turn on `target` spends metered dollars: a metered target, or one on a harness whose subscription is `paying`. */
export const spendsMetered = (target: Pick<RouteTarget, "harness" | "access">, paying: readonly HarnessId[]) =>
  target.access === "metered" || paying.includes(target.harness);

/**
 * The first untrusted input a harness session took in (DESIGN §17): `source`, e.g. `WebFetch`, in the thread's turn
 * number `turn`, counting from 1.
 */
export const UntrustedInput = Schema.Struct({ source: Schema.String, turn: Schema.Int });
export type UntrustedInput = typeof UntrustedInput.Type;

/** `task.started` v2's inputs; read as today's without `untrusted`. */
export const RouteInputsV1 = Schema.Struct({
  /** The thread's route when the task started: the pin, or the warm session's. */
  route: Route,
  pinned: Schema.Boolean,
  /** The user's budget mode for the thread; null when the policy's applied. */
  budgetMode: Schema.NullOr(BudgetMode),
  /** Whether the thread had a warm harness session, and how much context it had cached. */
  warm: Schema.Boolean,
  cachedTokens: Schema.Number,
  /** The harnesses verdandid ran. */
  harnesses: Schema.Array(HarnessId),
  /** The project's routing memory, when the router consulted it. */
  memory: Schema.optionalKey(Schema.Array(RouteStats)),
  /** The spend cap that was reached, when one was. */
  capped: Schema.optionalKey(SpendCapped),
  /** The model the task's message named with a leading `@name`, which pinned the task; the stored text is without it. */
  at: Schema.optionalKey(Schema.String),
});

/**
 * What the router read about a new task besides its text and mode (kept in its `task.started`), so offline
 * replay (DESIGN §8.8 level 2) can route it again exactly. Provider health and quota aren't recorded: replay routes as
 * if every provider were healthy.
 */
export const RouteInputs = Schema.Struct({
  ...RouteInputsV1.fields,
  /** The untrusted input the warm session held, when it could do harm with it, which floors the route. */
  untrusted: Schema.optionalKey(UntrustedInput),
});
export type RouteInputs = typeof RouteInputs.Type;

/** One step of how the router reached a decision, shown when the user opens the route's trace. */
export const RuleTrace = Schema.Struct({
  stage: Schema.Literals(["pin", "candidates", "signals", "classify", "policy", "memory", "switch", "subagents"]),
  note: Schema.String,
});
export type RuleTrace = typeof RuleTrace.Type;

/** The router's answer for a task (DESIGN §8.1). Pinned tasks are classified too, so overrides can be learned from. */
export const RouteDecision = Schema.Struct({
  /** `memory`: the project's routing memory moved the task off the policy's route. */
  source: Schema.Literals(["pin", "policy", "memory"]),
  taskClass: TaskClass,
  difficulty: Schema.Number,
  confidence: Schema.Number,
  target: RouteTarget,
  effort: Effort,
  /** The task's subagent routes: the policy's for a new session, the warm session's own otherwise. Absent when there are none. */
  subagents: Schema.optionalKey(SubagentRoutes),
  /** Effective cost in dollar equivalents (DESIGN §8.3). Absent for a pinned target the catalog doesn't know. */
  estimate: Schema.optionalKey(Schema.Struct({ tokens: Schema.Int, cost: Schema.Number, switchCost: Schema.Number })),
  /** One sentence, shown in the UI. */
  reason: Schema.String,
  trace: Schema.Array(RuleTrace),
  /** The task's budget guards, from its class's policy; absent when the policy sets none. */
  limits: Schema.optionalKey(TaskLimits),
  /** The routing memory the router consulted: its class on the policy's route, whether or not it moved the route. */
  memory: Schema.optionalKey(RouteStats),
});
export type RouteDecision = typeof RouteDecision.Type;
