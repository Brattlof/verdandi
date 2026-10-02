import { Schema } from "effect";
import { AttachmentRef, AttachmentUpload } from "./attachments.ts";
import { DecisionAnswer } from "./decisions.ts";
import { HarnessEvent } from "./harness.ts";
import { CommandId, TaskId, ThreadId, TurnId } from "./ids.ts";
import { HandedSource, VerifierRun } from "./items.ts";
import { MemoryScope } from "./memory.ts";
import { Resolution } from "./requests.ts";
import { InteractionMode, Route } from "./route.ts";
import { BudgetMode } from "./routing.ts";
import { SkillAction, SkillChange } from "./skills.ts";
import { CapPeriod, CapScope } from "./spend.ts";
import { TaskRating } from "./task.ts";
import { WorktreeReport } from "./worktree.ts";

export const ThreadCreate = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectPath: Schema.String,
  /** The user's pick, which pins the thread to it. Left out, the router picks a route for each new task. */
  route: Schema.optionalKey(Route),
  /** Runs the thread in a git worktree of its own, on a new branch from the project's `HEAD` (DESIGN §13). */
  worktree: Schema.optionalKey(Schema.Boolean),
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

/** The user rates the thread's task `taskId` up or down (DESIGN §8.8); `null` clears the rating. */
export const TaskRate = Schema.Struct({
  type: Schema.Literal("task.rate"),
  commandId: CommandId,
  threadId: ThreadId,
  taskId: TaskId,
  rating: Schema.NullOr(TaskRating),
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

/**
 * Gives a thread a worktree: a new one for a thread that has had no turns, or the one it had again, on its
 * kept branch, after it was removed or failed to be added.
 */
export const ThreadWorktreeAdd = Schema.Struct({
  type: Schema.Literal("thread.worktree.add"),
  commandId: CommandId,
  threadId: ThreadId,
});

/**
 * Removes the thread's worktree and keeps its branch. git refuses while it has uncommitted changes or
 * untracked files, unless `force`.
 */
export const ThreadWorktreeRemove = Schema.Struct({
  type: Schema.Literal("thread.worktree.remove"),
  commandId: CommandId,
  threadId: ThreadId,
  force: Schema.Boolean,
});

/** Internal: the reactor reporting what happened to a thread's worktree. Clients cannot send it. */
export const WorktreeReported = Schema.Struct({
  type: Schema.Literal("worktree.report"),
  commandId: CommandId,
  threadId: ThreadId,
  report: WorktreeReport,
});

/**
 * Rolls the thread back to the end of turn `toTurnId` (DESIGN §13): the conversation, and with `files` the
 * project's files too, from that turn's checkpoint. The later turns stay in the log, shown as reverted.
 */
export const ThreadRevert = Schema.Struct({
  type: Schema.Literal("thread.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  toTurnId: TurnId,
  files: Schema.Boolean,
});

/** Undoes the thread's latest revert, files included, while no turn has run since. */
export const ThreadRevertUndo = Schema.Struct({
  type: Schema.Literal("thread.revert.undo"),
  commandId: CommandId,
  threadId: ThreadId,
});

/** Internal: the reactor reporting that it restored the thread's files from checkpoint `from`, or why it couldn't. */
export const FilesReport = Schema.Struct({
  type: Schema.Literal("files.report"),
  commandId: CommandId,
  threadId: ThreadId,
  from: Schema.String,
  /** The checkpoint of the files as they were before, which undoing the revert restores. */
  saved: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});

/** Internal: the cleanup sweep reporting the thread's checkpoint and revert refs it removed (ADR 0021). Clients cannot send it. */
export const CheckpointsReport = Schema.Struct({
  type: Schema.Literal("checkpoints.report"),
  commandId: CommandId,
  threadId: ThreadId,
  refs: Schema.Array(Schema.String),
});

/** Internal: the agent of running turn `turnId` called `report_blocked`. Clients cannot send it. */
export const TaskBlock = Schema.Struct({
  type: Schema.Literal("task.block"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  reason: Schema.String,
});

/**
 * Remembers `text` in the thread's user or project memory (DESIGN §14.2), replacing the entries `replaces`
 * names: that is how a full store is consolidated. The agent's `memory_save` sends it with its `turnId`; the
 * Memory panel without. Scanned for secrets, injection and exfiltration first; refused over the store's cap.
 */
export const MemorySave = Schema.Struct({
  type: Schema.Literal("memory.save"),
  commandId: CommandId,
  threadId: ThreadId,
  scope: MemoryScope,
  text: Schema.String,
  replaces: Schema.optionalKey(Schema.Array(Schema.String)),
  turnId: Schema.optionalKey(TurnId),
});

/** The user rewrites a remembered fact from the Memory panel. Scanned and capped like a save. */
export const MemoryEdit = Schema.Struct({
  type: Schema.Literal("memory.edit"),
  commandId: CommandId,
  threadId: ThreadId,
  entryId: Schema.String,
  text: Schema.String,
});

/** The user forgets a remembered fact from the Memory panel. */
export const MemoryDelete = Schema.Struct({
  type: Schema.Literal("memory.delete"),
  commandId: CommandId,
  threadId: ThreadId,
  entryId: Schema.String,
});

/**
 * Internal: the agent of running turn `turnId` proposes `change` to a profile skill (`skill_manage`, DESIGN §14.4).
 * verdandid read the file as it is (`before`) and checked the path didn't leave the skills folder; the decider checks
 * the change and scans it, then records it as a pending request. Its id is the command's. Clients cannot send it.
 */
export const SkillPropose = Schema.Struct({
  type: Schema.Literal("skill.propose"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  change: SkillChange,
});
/** Internal: the reactor reporting that it wrote the allowed skill proposal `requestId`, or why it couldn't. */
export const SkillReport = Schema.Struct({
  type: Schema.Literal("skill.report"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  requestId: Schema.String,
  action: SkillAction,
  skill: Schema.String,
  path: Schema.String,
  error: Schema.optionalKey(Schema.String),
});

/** Internal: a reactor reporting what the harness did. Clients cannot send it. */
export const HarnessReport = Schema.Struct({
  type: Schema.Literal("harness.report"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  event: HarnessEvent,
});
/** Internal: the reactor saying the agent of the running turn `turnId` finished and its verifiers are about to run. */
export const VerifiersStart = Schema.Struct({
  type: Schema.Literal("verifiers.start"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
});
/** Internal: the reactor reporting a verifier it ran for the running turn `turnId`. Clients cannot send it. */
export const VerifierReport = Schema.Struct({
  type: Schema.Literal("verifier.report"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  run: VerifierRun,
});
/**
 * Internal: the reactor asking to escalate the task of turn `turnId`, after which its verifier `run` failed, its
 * agent reported it is blocked for `reason`, or the same tool error came back once too often (DESIGN §8.7). A
 * follow-up turn, if the ladder takes a step, gets `nextTurnId`. Clients cannot send it.
 */
export const TaskEscalate = Schema.Struct({
  type: Schema.Literal("task.escalate"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  nextTurnId: TurnId,
  trigger: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("verifier"), run: VerifierRun }),
    Schema.Struct({ kind: Schema.Literal("blocked"), reason: Schema.String }),
    /** Tool `tool` failed with the same error `count` times in the task since it last escalated; `error` is its latest text, untrusted data. */
    Schema.Struct({ kind: Schema.Literal("repeated-error"), tool: Schema.String, error: Schema.String, count: Schema.Int }),
  ]),
});
/**
 * Internal: the decision layer flagged a Verdandi tool's result (`answer`) before it reached the agent running
 * `turnId`, which got it under a warning. Records `injection.flagged`.
 */
export const InjectionFlag = Schema.Struct({
  type: Schema.Literal("injection.flag"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  source: HandedSource,
  text: Schema.String,
  answer: DecisionAnswer,
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
  TaskRate,
  ThreadArchive,
  ThreadUnarchive,
  ThreadWorktreeAdd,
  ThreadWorktreeRemove,
  ThreadRevert,
  ThreadRevertUndo,
  MemorySave,
  MemoryEdit,
  MemoryDelete,
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
  TaskRate,
  ThreadArchive,
  ThreadUnarchive,
  ThreadWorktreeAdd,
  ThreadWorktreeRemove,
  ThreadRevert,
  ThreadRevertUndo,
  MemorySave,
  MemoryEdit,
  MemoryDelete,
  ApprovalRespond,
  HarnessReport,
  FilesReport,
  CheckpointsReport,
  TaskBlock,
  WorktreeReported,
  VerifiersStart,
  VerifierReport,
  TaskEscalate,
  InjectionFlag,
  TurnRecover,
  SkillPropose,
  SkillReport,
]);
export type Command = typeof Command.Type;
