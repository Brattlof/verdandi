import { Data, Effect, Schema } from "effect";
import { ProjectId, ThreadId, TurnId } from "./ids.ts";
import { Item, UsageFields } from "./items.ts";
import { Route } from "./route.ts";

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
export const TurnStarted = Schema.Struct({
  type: Schema.Literal("turn.started"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  text: Schema.String,
});
export const HarnessSessionBound = Schema.Struct({
  type: Schema.Literal("harness.session.bound"),
  v: v1,
  threadId: ThreadId,
  sessionId: Schema.String,
  harnessVersion: Schema.String,
});
export const TurnItemAdded = Schema.Struct({
  type: Schema.Literal("turn.item.added"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  item: Item,
});
export const TurnUsageRecorded = Schema.Struct({
  type: Schema.Literal("turn.usage.recorded"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  ...UsageFields,
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

export const Event = Schema.Union([ThreadCreated, TurnStarted, HarnessSessionBound, TurnItemAdded, TurnUsageRecorded, TurnCompleted]);
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
  "turn.started@1": TurnStarted,
  "harness.session.bound@1": HarnessSessionBound,
  "turn.item.added@1": TurnItemAdded,
  "turn.usage.recorded@1": TurnUsageRecorded,
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
