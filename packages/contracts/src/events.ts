import { Data, Effect, Schema } from "effect";
import { ProjectId, ThreadId, TurnId } from "./ids.ts";
import { Item, UsageFields } from "./items.ts";
import { Question, Resolution } from "./requests.ts";
import { InteractionMode, Route } from "./route.ts";

// Events are append-only and must stay readable forever. To change one, add a v2 schema
// next to v1 and upgrade v1 to v2 when it is read; never edit or delete a published version.

const v1 = Schema.Literal(1);

export const ThreadCreated = Schema.Struct({
  type: Schema.Literal("thread.created"),
  v: v1,
  threadId: ThreadId,
  projectId: ProjectId,
  projectPath: Schema.String,
  route: Route,
});
/** `by` records who changed the route, so overrides can be counted (DESIGN §8.8). */
export const ThreadRouteChanged = Schema.Struct({
  type: Schema.Literal("thread.route.changed"),
  v: v1,
  threadId: ThreadId,
  from: Route,
  to: Route,
  by: Schema.Literal("user"),
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
export const TurnStatus = Schema.Literals(["success", "error", "interrupted"]);
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
  TurnStarted,
  HarnessSessionBound,
  TurnItemAdded,
  TurnSteered,
  TurnUsageRecorded,
  ApprovalRequested,
  UserInputRequested,
  PlanRequested,
  ApprovalResolved,
  TurnCompleted,
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
  "turn.started@1": TurnStarted,
  "harness.session.bound@1": HarnessSessionBound,
  "turn.item.added@1": TurnItemAdded,
  "turn.steered@1": TurnSteered,
  "turn.usage.recorded@1": TurnUsageRecorded,
  "approval.requested@1": ApprovalRequested,
  "user-input.requested@1": UserInputRequested,
  "plan.requested@1": PlanRequested,
  "approval.resolved@1": ApprovalResolved,
  "turn.completed@1": TurnCompleted,
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
