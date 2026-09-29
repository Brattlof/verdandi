import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ClientCommand } from "./commands.ts";
import { StoredEvent, TurnStatus } from "./events.ts";
import { CommandId, ThreadId, TurnId } from "./ids.ts";
import { Item } from "./items.ts";
import { Route } from "./route.ts";

export class CommandRejected extends Schema.TaggedError<CommandRejected>()("CommandRejected", {
  reason: Schema.Literals(["ThreadNotFound", "ThreadExists", "ThreadBusy"]),
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
});
export type ThreadView = typeof ThreadView.Type;

export const ThreadFeed = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snapshot"), thread: ThreadView }),
  Schema.Struct({ kind: Schema.Literal("event"), stored: StoredEvent }),
  Schema.Struct({ kind: Schema.Literal("delta"), turnId: TurnId, text: Schema.String }),
]);
export type ThreadFeed = typeof ThreadFeed.Type;

/**
 * The client API. Feeds are long-lived: a client ends one with ThreadUnsubscribe, never by
 * stopping the stream early (ADR 0008).
 */
export class Api extends RpcGroup.make(
  Rpc.make("CommandDispatch", { payload: ClientCommand, success: Receipt, error: CommandRejected }),
  Rpc.make("ThreadSubscribe", { payload: { threadId: ThreadId, subscriptionId: Schema.String }, success: ThreadFeed, stream: true }),
  Rpc.make("ThreadUnsubscribe", { payload: { subscriptionId: Schema.String } }),
) {}
