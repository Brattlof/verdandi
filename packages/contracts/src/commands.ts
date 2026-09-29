import { Schema } from "effect";
import { HarnessEvent } from "./harness.ts";
import { CommandId, ThreadId, TurnId } from "./ids.ts";
import { Route } from "./route.ts";

export const ThreadCreate = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectPath: Schema.String,
  route: Route,
});
export const TurnSend = Schema.Struct({
  type: Schema.Literal("turn.send"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  text: Schema.String,
});

/** Internal: a reactor reporting what the harness did. Clients cannot send it. */
export const HarnessReport = Schema.Struct({
  type: Schema.Literal("harness.report"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  event: HarnessEvent,
});
/** Internal: marks a turn left running by a previous verdandid as interrupted. */
export const TurnRecover = Schema.Struct({
  type: Schema.Literal("turn.recover"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
});

/** What clients may send over RPC. */
export const ClientCommand = Schema.Union([ThreadCreate, TurnSend]);
export type ClientCommand = typeof ClientCommand.Type;

export const Command = Schema.Union([ThreadCreate, TurnSend, HarnessReport, TurnRecover]);
export type Command = typeof Command.Type;
