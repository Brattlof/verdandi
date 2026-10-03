import { Schema } from "effect";
import { TaskId, ThreadId } from "./ids.ts";
import { Usage } from "./items.ts";
import { Route } from "./route.ts";
import { EscalationStep, EscalationTrigger } from "./routing.ts";

// Persisted: like events, a published version is never edited. A change is a v2 plus an upgrade on read.

/**
 * `reverted` waits for checkpoints. `escalated` isn't written: a task's status is how it ended, and `escalations` counts
 * the steps it took (DESIGN §8.7); routing memory counts an escalated task against the route it started on.
 * `limit`: a budget guard (`maxCost` or `maxTurns`) stopped the task.
 */
export const TaskStatus = Schema.Literals(["completed", "abandoned", "reverted", "escalated", "failed", "limit"]);
export type TaskStatus = typeof TaskStatus.Type;

/** The user's thumbs up (1) or down (-1) on a task. */
export const TaskRating = Schema.Literals([1, -1]);
export type TaskRating = typeof TaskRating.Type;

/** v1 reads as v2 without a rating. */
const TaskOutcomeV1 = Schema.Struct({
  v: Schema.Literal(1),
  taskId: TaskId,
  threadId: ThreadId,
  route: Route,
  status: TaskStatus,
  turns: Schema.Number,
  /** From 1 (no corrections) down to -1; see `buildTaskOutcomes`. */
  implicitSatisfaction: Schema.Number,
  /** The user changed the route before the task's next turn: `from` is the task's route, `to` the last one chosen. */
  userOverride: Schema.optionalKey(Schema.Struct({ from: Route, to: Route })),
  verifierRuns: Schema.Array(Schema.Struct({ command: Schema.String, passed: Schema.Boolean })),
  escalations: Schema.Number,
  /** One entry per model and access mode, summed over the task's turns. */
  usage: Schema.Array(Usage),
  /** Time the task's turns ran, summed; the user's time between turns doesn't count. */
  wallMs: Schema.Number,
});
/** v2 reads as v3 without `triggers`. */
const TaskOutcomeV2 = Schema.Struct({
  ...TaskOutcomeV1.fields,
  v: Schema.Literal(2),
  /** The user's latest rating of the task; absent when there's none, or it was cleared. */
  rating: Schema.optionalKey(TaskRating),
});
/** v3 reads as v4 with no fallbacks. */
const TaskOutcomeV3 = Schema.Struct({
  ...TaskOutcomeV2.fields,
  v: Schema.Literal(3),
  /** Each escalation trigger that fired on the task, in order, and the ladder step it took; `escalations` counts those that moved it. */
  triggers: Schema.Array(Schema.Struct({ trigger: EscalationTrigger, step: EscalationStep })),
});
/**
 * How a task went, for routing memory and the lab (DESIGN §8.8). Rewritten after each of its turns and each
 * rating; its turns are final once the next task starts.
 */
export const TaskOutcome = Schema.Struct({
  ...TaskOutcomeV3.fields,
  v: Schema.Literal(4),
  /** How many of its turns moved to another target when a provider failed (DESIGN §9.5); `route` stays the one it started on. */
  fallbacks: Schema.Number,
});
export type TaskOutcome = typeof TaskOutcome.Type;

/**
 * What a route's tasks cost. `costUsd` is every task's cost, failed ones included, so `costPerCompletedUsd`
 * (null until one completes) is what finishing a task on this route actually costs.
 */
export const RouteCost = Schema.Struct({
  route: Route,
  tasks: Schema.Number,
  completed: Schema.Number,
  costUsd: Schema.Number,
  costPerCompletedUsd: Schema.NullOr(Schema.Number),
});
export type RouteCost = typeof RouteCost.Type;
