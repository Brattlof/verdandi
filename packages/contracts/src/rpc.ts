import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ClientCommand } from "./commands.ts";
import { ApprovalRequested, StoredEvent, TurnStatus, UserInputRequested } from "./events.ts";
import { CommandId, ThreadId, TurnId } from "./ids.ts";
import { Item } from "./items.ts";
import { Route } from "./route.ts";

export class CommandRejected extends Schema.TaggedError<CommandRejected>()("CommandRejected", {
  reason: Schema.Literals(["ThreadNotFound", "ThreadExists", "ThreadBusy", "RequestNotPending", "InvalidResolution"]),
  message: Schema.String,
}) {}

export const Receipt = Schema.Struct({ commandId: CommandId, seq: Schema.Number });
export type Receipt = typeof Receipt.Type;

export const TurnView = Schema.Struct({
  turnId: TurnId,
  text: Schema.String,
  status: Schema.Literals(["running", ...TurnStatus.literals]),
  items: Schema.Array(Item),
  error: Schema.optionalKey(Schema.String),
});
export type TurnView = typeof TurnView.Type;

export const ThreadView = Schema.Struct({
  threadId: ThreadId,
  projectPath: Schema.String,
  route: Route,
  sessionId: Schema.NullOr(Schema.String),
  busy: Schema.Boolean,
  turns: Schema.Array(TurnView),
  /** Requests still waiting for an answer, oldest first, so a client that reconnects can answer them. */
  pendingRequests: Schema.Array(Schema.Union([ApprovalRequested, UserInputRequested])),
});
export type ThreadView = typeof ThreadView.Type;

export const ThreadFeed = Schema.Union([
  /** `seq` is the last event the snapshot includes; later events follow in order. */
  Schema.Struct({ kind: Schema.Literal("snapshot"), thread: ThreadView, seq: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("event"), stored: StoredEvent }),
  Schema.Struct({ kind: Schema.Literal("delta"), turnId: TurnId, text: Schema.String }),
]);
export type ThreadFeed = typeof ThreadFeed.Type;

/**
 * The client API. Feeds are long-lived: a client ends one with ThreadUnsubscribe, never by
 * stopping the stream early (ADR 0008). Make other calls outside a feed consumer, as `verdandi chat`
 * does: awaiting one inside the consumer hung a test on macOS CI.
 */
export class Api extends RpcGroup.make(
  Rpc.make("CommandDispatch", { payload: ClientCommand, success: Receipt, error: CommandRejected }),
  Rpc.make("ThreadSubscribe", {
    payload: { threadId: ThreadId, subscriptionId: Schema.String },
    success: ThreadFeed,
    error: CommandRejected,
    stream: true,
  }),
  Rpc.make("ThreadUnsubscribe", { payload: { subscriptionId: Schema.String } }),
) {}
