import { Schema } from "effect";
import { AttachmentRef, AttachmentUpload } from "./attachments.ts";
import { HarnessEvent } from "./harness.ts";
import { CommandId, ThreadId, TurnId } from "./ids.ts";
import { VerifierRun } from "./items.ts";
import { Resolution } from "./requests.ts";
import { InteractionMode, Route } from "./route.ts";
import { BudgetMode } from "./routing.ts";
import { CapPeriod, CapScope } from "./spend.ts";

export const ThreadCreate = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectPath: Schema.String,
  /** The user's pick, which pins the thread to it. Left out, the router picks a route for each new task. */
  route: Schema.optionalKey(Route),
});
/** A turn as the engine takes it: attachments are references to stored bytes. */
export const TurnSend = Schema.Struct({
  type: Schema.Literal("turn.send"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  text: Schema.String,
  mode: InteractionMode,
  attachments: Schema.optionalKey(Schema.Array(AttachmentRef)),
});
/**
 * A turn as a client sends it: attachments carry their bytes, which verdandid checks (type, size) and stores
 * content-addressed at the RPC boundary before the engine sees the command. Absent from clients built before attachments.
 */
export const ClientTurnSend = Schema.Struct({ ...TurnSend.fields, attachments: Schema.optionalKey(Schema.Array(AttachmentUpload)) });
/** Answers a pending approval or user-input request. */
export const ApprovalRespond = Schema.Struct({
  type: Schema.Literal("approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: Schema.String,
  resolution: Resolution,
});
/** Guidance for the running turn `turnId`; the agent reads it at its next tool boundary (ADR 0003). */
export const TurnSteer = Schema.Struct({
  type: Schema.Literal("turn.steer"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  text: Schema.String,
});
/** Stops the running turn `turnId`. It ends as `interrupted`, and the thread's next turn continues the same session. */
export const TurnInterrupt = Schema.Struct({
  type: Schema.Literal("turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
});
/** The user changing a thread's route. It applies from the next turn, never mid-turn. */
export const ThreadRouteSet = Schema.Struct({
  type: Schema.Literal("thread.route.set"),
  commandId: CommandId,
  threadId: ThreadId,
  route: Route,
});

/** Lets the router pick the thread's route again, from its next task on: the way back from a pin. */
export const ThreadRouteUnpin = Schema.Struct({
  type: Schema.Literal("thread.route.unpin"),
  commandId: CommandId,
  threadId: ThreadId,
});

/**
 * The user choosing how the router trades cost against strength for this thread's tasks; `null` goes back
 * to the policy's mode. It applies from the next task, which the thread's next turn starts.
 */
export const ThreadBudgetSet = Schema.Struct({
  type: Schema.Literal("thread.budget.set"),
  commandId: CommandId,
  threadId: ThreadId,
  mode: Schema.NullOr(BudgetMode),
});

/**
 * Raises the thread's profile or project spend cap for the rest of its period by the configured amount,
 * so a cap of $5 a day allows $10 today. Recorded as the user's override.
 */
export const SpendCapRaise = Schema.Struct({
  type: Schema.Literal("spend.cap.raise"),
  commandId: CommandId,
  threadId: ThreadId,
  scope: CapScope,
  period: CapPeriod,
});

/**
 * Forgets the routing memory of the thread's project (DESIGN §8.8): its later tasks route on the policy alone,
 * until new outcomes build memory again.
 */
export const RoutingMemoryClear = Schema.Struct({
  type: Schema.Literal("routing.memory.clear"),
  commandId: CommandId,
  threadId: ThreadId,
});

/** Puts a thread away: it leaves the thread lists, and nothing is deleted. A thread with a running turn can't be archived. */
export const ThreadArchive = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

/** Brings an archived thread back into the thread lists, so it takes turns again. */
export const ThreadUnarchive = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

/** Internal: a reactor reporting what the harness did. Clients cannot send it. */
export const HarnessReport = Schema.Struct({
  type: Schema.Literal("harness.report"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  event: HarnessEvent,
});
/** Internal: the reactor reporting a verifier it ran for the running turn `turnId`. Clients cannot send it. */
export const VerifierReport = Schema.Struct({
  type: Schema.Literal("verifier.report"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  run: VerifierRun,
});
/** Internal: marks a turn left running by a previous verdandid as interrupted. */
export const TurnRecover = Schema.Struct({
  type: Schema.Literal("turn.recover"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
});

/** What clients may send over RPC. */
export const ClientCommand = Schema.Union([
  ThreadCreate,
  ClientTurnSend,
  TurnSteer,
  TurnInterrupt,
  ThreadRouteSet,
  ThreadRouteUnpin,
  ThreadBudgetSet,
  SpendCapRaise,
  RoutingMemoryClear,
  ThreadArchive,
  ThreadUnarchive,
  ApprovalRespond,
]);
export type ClientCommand = typeof ClientCommand.Type;

export const Command = Schema.Union([
  ThreadCreate,
  TurnSend,
  TurnSteer,
  TurnInterrupt,
  ThreadRouteSet,
  ThreadRouteUnpin,
  ThreadBudgetSet,
  SpendCapRaise,
  RoutingMemoryClear,
  ThreadArchive,
  ThreadUnarchive,
  ApprovalRespond,
  HarnessReport,
  VerifierReport,
  TurnRecover,
]);
export type Command = typeof Command.Type;
