import { Schema } from "effect";
import { AttachmentRef, AttachmentUpload } from "./attachments.ts";
import { DecisionAnswer } from "./decisions.ts";
import { DevicePair, DeviceRevoke } from "./devices.ts";
import {
  ChannelBind,
  ChannelUnbind,
  DeliveryAbandon,
  DeliveryAttempt,
  DeliveryReport,
  GatewayOwnerSet,
  GatewayPairingRequest,
  PairingApprove,
  PairingDeny,
  SenderRevoke,
} from "./gateway.ts";
import { HarnessEvent } from "./harness.ts";
import { CommandId, profileStream, TaskId, ThreadId, TurnId } from "./ids.ts";
import { HandedSource, VerifierRun } from "./items.ts";
import { MemoryScope } from "./memory.ts";
import { Resolution } from "./requests.ts";
import { HarnessId, InteractionMode, Route, SubagentProfile } from "./route.ts";
import { BudgetMode } from "./routing.ts";
import { HubKept, HubPin, SkillAction, SkillChange } from "./skills.ts";
import { CapPeriod, CapScope } from "./spend.ts";
import { TaskRating } from "./task.ts";
import { TrustPurpose } from "./trust.ts";
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
 * Rolls the thread back to the end of turn `toTurnId` (DESIGN §13): the conversation, and with `files` the files
 * the later turns changed in the thread's folder too, from that turn's checkpoint. The later turns stay in the log,
 * shown as reverted.
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
  /** The paths it restored, relative to the repo's top; undoing the revert puts back just these. */
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Whether it restored the whole thread folder, since a reverted turn had no checkpoints. */
  whole: Schema.Boolean,
  /** Files, absolute, the reverted turns' file tools changed outside the thread folder, which it left as they are. */
  outside: Schema.Array(Schema.String),
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
 * Internal: the native agent of running turn `turnId` delegates `task` with `delegate_task` call `toolUseId`, naming
 * `profile` when it wants the route's explorer or reviewer (DESIGN §9.4): Verdandi routes the child. Clients cannot send it.
 */
export const TaskDelegate = Schema.Struct({
  type: Schema.Literal("task.delegate"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  toolUseId: Schema.String,
  task: Schema.String,
  profile: Schema.optionalKey(SubagentProfile),
});

/**
 * Internal: smart approvals' guard answered about a terminal command of running turn `turnId` (DESIGN §17): `state` is
 * what it was asked about, the command with its comments stripped, fenced as data. Recorded for the lab. Clients cannot send it.
 */
export const ApprovalGuard = Schema.Struct({
  type: Schema.Literal("approval.guard"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  state: Schema.String,
  answer: DecisionAnswer,
});

/**
 * Turns smart approvals (DESIGN §17) on or off for the profile, where `approvals.yaml` enables them: the composer's one
 * click, and `/smart` in `verdandi chat`. Without `smart: true` in that file it changes nothing.
 */
export const ApprovalsSmartSet = Schema.Struct({ type: Schema.Literal("approvals.smart.set"), commandId: CommandId, on: Schema.Boolean });

/**
 * Internal: tool `tool` failed with the same error `count` times in the task of running turn `turnId` since it last
 * escalated (`escalation.repeatedErrors`), recorded before the turn completes. Clients cannot send it.
 */
export const TaskErrorRepeat = Schema.Struct({
  type: Schema.Literal("task.error.repeat"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  tool: Schema.String,
  count: Schema.Int,
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
/**
 * Internal: the reactor reporting that it wrote the allowed skill proposal or the revert `requestId` (a revert has no
 * turn), or why it couldn't.
 */
export const SkillReport = Schema.Struct({
  type: Schema.Literal("skill.report"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optionalKey(TurnId),
  requestId: Schema.String,
  action: SkillAction,
  skill: Schema.String,
  path: Schema.String,
  error: Schema.optionalKey(Schema.String),
});
/**
 * Internal: the daily sweep moves skill `skill`, which Verdandi created in thread `threadId`, to `to` for going unused
 * (DESIGN §14.4). Accepted with no events when the skill is already there, used since, or gone. Clients cannot send it.
 */
export const SkillCurate = Schema.Struct({
  type: Schema.Literal("skill.curate"),
  commandId: CommandId,
  threadId: ThreadId,
  skill: Schema.String,
  to: Schema.Literals(["stale", "archived"]),
  /** The last use the sweep went by: a skill used since keeps its state. */
  usedAt: Schema.String,
});
/**
 * The user brings archived skill `skill` back to the folder Claude Code loads, from the Skills panel or `verdandi skills
 * restore`. `threadId` is the thread that created it (its `curation.threadId`), whose log holds the skill's history.
 */
export const SkillRestore = Schema.Struct({
  type: Schema.Literal("skill.restore"),
  commandId: CommandId,
  threadId: ThreadId,
  skill: Schema.String,
});
/**
 * The user reverts the written skill change `changeId` (an entry of `SkillHistoryGet`), from the Skills panel or
 * `verdandi skills revert`: its `before` goes back. `threadId` is the change's, whose log holds it, and records the revert.
 */
export const SkillRevert = Schema.Struct({
  type: Schema.Literal("skill.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  changeId: Schema.String,
});
/**
 * The user pins the profile skill `skill`, so no agent's proposal can change it and curation leaves it alone, or
 * unpins it. A pin belongs to the profile, not a thread: recorded on `profileStream`.
 */
export const SkillPin = Schema.Struct({ type: Schema.Literal("skill.pin"), commandId: CommandId, skill: Schema.String });
export const SkillUnpin = Schema.Struct({ type: Schema.Literal("skill.unpin"), commandId: CommandId, skill: Schema.String });

/**
 * Internal: verdandid fetched hub skill `skill` at `pin` for the user's install or update (the `SkillInstall` RPC) and
 * proposes what it would write, as `skill.install.proposed` on the Skills hub thread `threadId`, which it creates in the
 * workspace `projectPath` first if it has to. The decider checks each change and scans it. Clients cannot send it.
 */
export const SkillInstallPropose = Schema.Struct({
  type: Schema.Literal("skill.install.propose"),
  commandId: CommandId,
  threadId: ThreadId,
  projectPath: Schema.String,
  skill: Schema.String,
  pin: HubPin,
  from: Schema.optionalKey(Schema.String),
  changes: Schema.Array(SkillChange),
  kept: Schema.Array(HubKept),
  taken: Schema.Array(Schema.String),
  digests: Schema.Record(Schema.String, Schema.String),
});
/** Internal: the reactor reporting that it wrote the allowed hub install `requestId`, or why it couldn't. */
export const SkillInstallReport = Schema.Struct({
  type: Schema.Literal("skill.install.report"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: Schema.String,
  skill: Schema.String,
  pin: HubPin,
  digests: Schema.Record(Schema.String, Schema.String),
  error: Schema.optionalKey(Schema.String),
});
/**
 * The user uninstalls hub skill `skill`, from the Skills panel or `verdandi skills uninstall`: its folder moves to the
 * archive. A profile matter, recorded on `profileStream`.
 */
export const SkillUninstall = Schema.Struct({ type: Schema.Literal("skill.uninstall"), commandId: CommandId, skill: Schema.String });
/** Internal: the reactor moved uninstalled hub skill `skill`'s folder to the archive, or says why it couldn't. */
export const SkillUninstallReport = Schema.Struct({
  type: Schema.Literal("skill.uninstall.report"),
  commandId: CommandId,
  skill: Schema.String,
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
 * Internal: the decision layer flagged a Verdandi tool's result or a context `file` (`answer`) before it reached the
 * agent running `turnId`. Records `injection.flagged`.
 */
export const InjectionFlag = Schema.Struct({
  type: Schema.Literal("injection.flag"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  source: HandedSource,
  text: Schema.String,
  answer: DecisionAnswer,
  file: Schema.optionalKey(Schema.String),
  withheld: Schema.optionalKey(Schema.Boolean),
});
/**
 * Internal: task `taskId` of the thread finished turn `turnId`; `digest` sums up its turns since its last review
 * (DESIGN §14.5). The engine asks the decision layer whether it's worth a background review, which would run in
 * thread `reviewThreadId`.
 */
export const TaskReview = Schema.Struct({
  type: Schema.Literal("task.review"),
  commandId: CommandId,
  threadId: ThreadId,
  taskId: TaskId,
  turnId: TurnId,
  reviewThreadId: ThreadId,
  digest: Schema.String,
});
/** Internal: creates review thread `threadId` in `projectPath` for a `review.requested` (DESIGN §14.5). */
export const ReviewStart = Schema.Struct({
  type: Schema.Literal("review.start"),
  commandId: CommandId,
  threadId: ThreadId,
  projectPath: Schema.String,
  reviews: Schema.Struct({ threadId: ThreadId, taskId: TaskId, turnId: TurnId }),
  allowMetered: Schema.Boolean,
});
/**
 * Internal: creates handoff thread `threadId` in `projectPath` (DESIGN §8.2 lever 5): its one turn writes the summary
 * that seeds the new `to` session of turn `for.turnId`, whose thread last ran on `from`.
 */
export const HandoffStart = Schema.Struct({
  type: Schema.Literal("handoff.start"),
  commandId: CommandId,
  threadId: ThreadId,
  projectPath: Schema.String,
  for: Schema.Struct({ threadId: ThreadId, turnId: TurnId }),
  from: HarnessId,
  to: HarnessId,
});
/**
 * Internal: creates compression thread `threadId` in `projectPath` (DESIGN §16): its one turn writes the summary a
 * compression of turn `for.turnId`'s native session puts in place of the conversation before a recent tail.
 */
export const CompressionStart = Schema.Struct({
  type: Schema.Literal("compression.start"),
  commandId: CommandId,
  threadId: ThreadId,
  projectPath: Schema.String,
  for: Schema.Struct({ threadId: ThreadId, turnId: TurnId }),
});
/**
 * Internal: review thread `reviewThreadId` proposes a memory (a routing note is one, in project memory) or a skill
 * change, after turn `turnId` of the reviewed thread `threadId`. Untrusted: scanned like a save, then recorded as a
 * pending request for the user.
 */
export const ReviewPropose = Schema.Struct({
  type: Schema.Literal("review.propose"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  reviewThreadId: ThreadId,
  proposal: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("memory"), scope: MemoryScope, text: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("skill"), change: SkillChange }),
  ]),
});
/**
 * Internal: the reactor would run the project's own `commands`, which the user hasn't trusted for the project, and asks
 * on running turn `turnId` first. Its request id is the command's. Clients cannot send it.
 */
export const CommandsTrustRequest = Schema.Struct({
  type: Schema.Literal("commands.trust.request"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  purpose: TrustPurpose,
  commands: Schema.Array(Schema.String),
});
/**
 * The user revokes their trust in command list `hash` of the thread's project, from the projects page or `verdandi chat`'s
 * `/untrust`: verdandid asks again before it runs that list.
 */
export const CommandsTrustRevoke = Schema.Struct({
  type: Schema.Literal("commands.trust.revoke"),
  commandId: CommandId,
  threadId: ThreadId,
  hash: Schema.String,
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
  SkillRestore,
  SkillRevert,
  SkillPin,
  SkillUnpin,
  SkillUninstall,
  ApprovalRespond,
  CommandsTrustRevoke,
  DeviceRevoke,
  ApprovalsSmartSet,
  PairingApprove,
  PairingDeny,
  SenderRevoke,
  GatewayOwnerSet,
  ChannelUnbind,
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
  SkillRestore,
  SkillRevert,
  SkillPin,
  SkillUnpin,
  SkillUninstall,
  ApprovalRespond,
  CommandsTrustRevoke,
  HarnessReport,
  FilesReport,
  CheckpointsReport,
  TaskBlock,
  TaskErrorRepeat,
  ApprovalGuard,
  ApprovalsSmartSet,
  TaskDelegate,
  WorktreeReported,
  VerifiersStart,
  VerifierReport,
  TaskEscalate,
  InjectionFlag,
  TurnRecover,
  SkillPropose,
  SkillReport,
  SkillCurate,
  SkillInstallPropose,
  SkillInstallReport,
  SkillUninstallReport,
  TaskReview,
  ReviewStart,
  ReviewPropose,
  HandoffStart,
  CompressionStart,
  CommandsTrustRequest,
  DeviceRevoke,
  DevicePair,
  GatewayPairingRequest,
  PairingApprove,
  PairingDeny,
  SenderRevoke,
  GatewayOwnerSet,
  ChannelBind,
  ChannelUnbind,
  DeliveryAttempt,
  DeliveryReport,
  DeliveryAbandon,
]);
export type Command = typeof Command.Type;

/** The stream a command's events go on: its thread's, or the profile's for a command about the profile. */
export const commandStream = (command: Command): ThreadId => ("threadId" in command ? command.threadId : profileStream);
