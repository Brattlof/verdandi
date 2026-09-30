import { Data, Effect, Schema } from "effect";
import { DecisionAnswer, DecisionQuestion } from "./decisions.ts";
import { ProjectId, TaskId, ThreadId, TurnId } from "./ids.ts";
import { Item, Quota, UsageFields } from "./items.ts";
import { Question, Resolution } from "./requests.ts";
import { HarnessId, InteractionMode, Route } from "./route.ts";
import { BudgetMode, RouteDecision } from "./routing.ts";
import { CapPeriod, CapScope } from "./spend.ts";

// Events are append-only and must stay readable forever. To change one, add a v2 schema
// next to v1 and upgrade v1 to v2 when it is read; never edit or delete a published version.

const v1 = Schema.Literal(1);

export const ThreadCreated = Schema.Struct({
  type: Schema.Literal("thread.created"),
  v: v1,
  threadId: ThreadId,
  projectId: ProjectId,
  projectPath: Schema.String,
  /** A placeholder until the first task is routed when `pinned` is false. */
  route: Route,
  /** False when the router picks each new task's route. Absent on threads from before routing: their route was always the user's. */
  pinned: Schema.optionalKey(Schema.Boolean),
});
/**
 * The user picked a route, which pins the thread to it from the next turn on. `by` records who changed
 * it, so overrides can be counted (DESIGN §8.8). `from` equals `to` when the user pins the routed route.
 */
export const ThreadRouteChanged = Schema.Struct({
  type: Schema.Literal("thread.route.changed"),
  v: v1,
  threadId: ThreadId,
  from: Route,
  to: Route,
  by: Schema.Literal("user"),
});
/**
 * A task (DESIGN §7) starts with the turn `taskId` names: a thread's first turn, and the first after a route
 * change. Committed right before that turn's `turn.started`; its turns run on `route`.
 */
export const TaskStarted = Schema.Struct({
  type: Schema.Literal("task.started"),
  v: v1,
  threadId: ThreadId,
  taskId: TaskId,
  route: Route,
  /** Why the task runs on `route`: the router's pick or the user's pin. Absent on tasks from before routing. */
  decision: Schema.optionalKey(RouteDecision),
});
/** The user let the router pick again: the thread's next turn starts a routed task. */
export const ThreadRouteUnpinned = Schema.Struct({
  type: Schema.Literal("thread.route.unpinned"),
  v: v1,
  threadId: ThreadId,
});
/**
 * The user set the thread's budget mode, or cleared it back to the policy's (`null`). An unrouted
 * thread's next turn starts a new task routed under it; a pinned thread keeps it for when it's unpinned.
 */
export const ThreadBudgetChanged = Schema.Struct({
  type: Schema.Literal("thread.budget.changed"),
  v: v1,
  threadId: ThreadId,
  mode: Schema.NullOr(BudgetMode),
});
/** The user cleared the routing memory of `threadId`'s project: outcomes of tasks started before this no longer move routes. */
export const RoutingMemoryCleared = Schema.Struct({
  type: Schema.Literal("routing.memory.cleared"),
  v: v1,
  threadId: ThreadId,
  projectId: ProjectId,
});
/** The user put the thread away: thread lists leave it out, and it takes no turns until unarchived. Nothing is deleted. */
export const ThreadArchived = Schema.Struct({
  type: Schema.Literal("thread.archived"),
  v: v1,
  threadId: ThreadId,
});
/** The user brought an archived thread back. */
export const ThreadUnarchived = Schema.Struct({
  type: Schema.Literal("thread.unarchived"),
  v: v1,
  threadId: ThreadId,
});
export const TurnStarted = Schema.Struct({
  type: Schema.Literal("turn.started"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  text: Schema.String,
  /** Absent on turns from before modes existed; those ran as `build`. */
  mode: Schema.optionalKey(InteractionMode),
});
export const HarnessSessionBound = Schema.Struct({
  type: Schema.Literal("harness.session.bound"),
  v: v1,
  threadId: ThreadId,
  sessionId: Schema.String,
  harnessVersion: Schema.String,
  /** The harness's own transcript file. Absent when it keeps none, and on sessions bound before it was recorded. */
  transcriptPath: Schema.optionalKey(Schema.String),
});
export const TurnItemAdded = Schema.Struct({
  type: Schema.Literal("turn.item.added"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  item: Item,
});
/** The user steered a running turn. Projected as a `user.steer` item of that turn. */
export const TurnSteered = Schema.Struct({
  type: Schema.Literal("turn.steered"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  text: Schema.String,
});
export const TurnUsageRecorded = Schema.Struct({
  type: Schema.Literal("turn.usage.recorded"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  ...UsageFields,
});
/** The harness's subscription window changed. The projection keeps only each harness's latest. */
export const HarnessQuotaReported = Schema.Struct({
  type: Schema.Literal("harness.quota.reported"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  harness: HarnessId,
  quota: Quota,
});
/** The harness waits for the user to allow or deny a tool call. */
export const ApprovalRequested = Schema.Struct({
  type: Schema.Literal("approval.requested"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  requestId: Schema.String,
  toolName: Schema.String,
  input: Schema.Unknown,
});
/** The harness waits for the user to answer questions. Answered or denied with `approval.resolved`. */
export const UserInputRequested = Schema.Struct({
  type: Schema.Literal("user-input.requested"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  requestId: Schema.String,
  questions: Schema.Array(Question),
});
/** The agent proposes a plan and waits for the user to approve it (`allow`) or reject it (`deny`). Projected as a `plan` item too. */
export const PlanRequested = Schema.Struct({
  type: Schema.Literal("plan.requested"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  requestId: Schema.String,
  plan: Schema.String,
  filePath: Schema.optionalKey(Schema.String),
  /**
   * Where approving moves the build: the router's pick for the task's class without its plan-mode route
   * (DESIGN §8.2 lever 3). Absent when the build stays on the thread's route, the thread is pinned, or the
   * plan came before this existed.
   */
  execute: Schema.optionalKey(RouteDecision),
});
/**
 * The user approved the plan of routed task `taskId`, and the router moved the rest of it to `to`, starting
 * with the running turn `turnId`. Committed right before that approval's `approval.resolved`, so the harness
 * switches before the agent's next step. Projected as a `route.switch` item of that turn.
 */
export const TaskRerouted = Schema.Struct({
  type: Schema.Literal("task.rerouted"),
  v: v1,
  threadId: ThreadId,
  taskId: TaskId,
  turnId: TurnId,
  from: Route,
  to: Route,
  decision: RouteDecision,
});
export const ApprovalResolved = Schema.Struct({
  type: Schema.Literal("approval.resolved"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  requestId: Schema.String,
  resolution: Resolution,
  /** Set when Verdandi denied the request itself, because its turn ended first; says why. */
  reason: Schema.optionalKey(Schema.String),
});
/**
 * The decision layer answered questions about turn `turnId` (DESIGN §9.8), committed right before that turn's
 * `task.started` or `turn.started`. The turn's text is the state, kept only in its `turn.started`. Logged for
 * the lab, to measure other backends against the one that answered.
 */
export const DecisionRecorded = Schema.Struct({
  type: Schema.Literal("decision.recorded"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  questions: Schema.Array(DecisionQuestion),
  /** One per question, in the same order. */
  answers: Schema.Array(DecisionAnswer),
});
/**
 * The user raised a spend cap from `fromUsd` to `toUsd` for the rest of the period `periodKey` (DESIGN §8.9),
 * from thread `threadId`. `projectId` names the project a project cap covers.
 */
export const SpendCapRaised = Schema.Struct({
  type: Schema.Literal("spend.cap.raised"),
  v: v1,
  threadId: ThreadId,
  scope: CapScope,
  projectId: Schema.optionalKey(ProjectId),
  period: CapPeriod,
  periodKey: Schema.String,
  fromUsd: Schema.Number,
  toUsd: Schema.Number,
});
/** `limit`: a budget guard of the task (its `maxCost` or `maxTurns`) stopped the turn, which ends the task. */
export const TurnStatus = Schema.Literals(["success", "error", "interrupted", "limit"]);
export const TurnCompleted = Schema.Struct({
  type: Schema.Literal("turn.completed"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  status: TurnStatus,
  error: Schema.optionalKey(Schema.String),
});

export const Event = Schema.Union([
  ThreadCreated,
  ThreadRouteChanged,
  ThreadRouteUnpinned,
  ThreadBudgetChanged,
  RoutingMemoryCleared,
  ThreadArchived,
  ThreadUnarchived,
  TaskStarted,
  TurnStarted,
  HarnessSessionBound,
  TurnItemAdded,
  TurnSteered,
  TurnUsageRecorded,
  HarnessQuotaReported,
  ApprovalRequested,
  UserInputRequested,
  PlanRequested,
  TaskRerouted,
  ApprovalResolved,
  TurnCompleted,
  DecisionRecorded,
  SpendCapRaised,
]);
export type Event = typeof Event.Type;

export const StoredEvent = Schema.Struct({
  seq: Schema.Number,
  eventId: Schema.String,
  commandId: Schema.String,
  at: Schema.String,
  event: Event,
});
export type StoredEvent = typeof StoredEvent.Type;

export class EventDecodeError extends Data.TaggedError("EventDecodeError")<{ readonly message: string }> {}

const byTypeAndVersion: Record<string, Schema.Codec<Event, unknown>> = {
  "thread.created@1": ThreadCreated,
  "thread.route.changed@1": ThreadRouteChanged,
  "thread.route.unpinned@1": ThreadRouteUnpinned,
  "thread.budget.changed@1": ThreadBudgetChanged,
  "routing.memory.cleared@1": RoutingMemoryCleared,
  "thread.archived@1": ThreadArchived,
  "thread.unarchived@1": ThreadUnarchived,
  "task.started@1": TaskStarted,
  "turn.started@1": TurnStarted,
  "harness.session.bound@1": HarnessSessionBound,
  "turn.item.added@1": TurnItemAdded,
  "turn.steered@1": TurnSteered,
  "turn.usage.recorded@1": TurnUsageRecorded,
  "harness.quota.reported@1": HarnessQuotaReported,
  "approval.requested@1": ApprovalRequested,
  "user-input.requested@1": UserInputRequested,
  "plan.requested@1": PlanRequested,
  "task.rerouted@1": TaskRerouted,
  "approval.resolved@1": ApprovalResolved,
  "turn.completed@1": TurnCompleted,
  "decision.recorded@1": DecisionRecorded,
  "spend.cap.raised@1": SpendCapRaised,
};

/** The row shape an event is stored as. */
export type EventRow = { readonly type: string; readonly v: number; readonly payload: string };

export const encodeEvent = (event: Event): EventRow => ({ type: event.type, v: event.v, payload: JSON.stringify(event) });

export const decodeStoredEvent = (row: EventRow): Effect.Effect<Event, EventDecodeError> => {
  const schema = byTypeAndVersion[`${row.type}@${row.v}`];
  if (!schema) {
    return Effect.fail(
      new EventDecodeError({
        message: `Stored event ${row.type} v${row.v} is newer than this build of Verdandi understands. Update Verdandi to read this database.`,
      }),
    );
  }
  return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(row.payload).pipe(
    Effect.mapError((e) => new EventDecodeError({ message: `Stored event ${row.type} v${row.v} is malformed: ${e.message}` })),
  );
};
