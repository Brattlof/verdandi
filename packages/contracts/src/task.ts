import { Schema } from "effect";
import { TaskId, ThreadId } from "./ids.ts";
import { Usage } from "./items.ts";
import { Route } from "./route.ts";

// Persisted: like events, a published version is never edited. A change is a v2 plus an upgrade on read.

/**
 * `reverted` and `escalated` wait for checkpoints and the router (DESIGN §8.7); nothing records them yet.
 * `limit`: a budget guard (`maxCost` or `maxTurns`) stopped the task.
 */
export const TaskStatus = Schema.Literals(["completed", "abandoned", "reverted", "escalated", "failed", "limit"]);
export type TaskStatus = typeof TaskStatus.Type;

/** How a task went, for routing memory and the lab (DESIGN §8.8). Rewritten after each of its turns; final once the next task starts. */
export const TaskOutcome = Schema.Struct({
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
