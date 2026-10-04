import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { AttachmentRef } from "./attachments.ts";
import { ClientCommand } from "./commands.ts";
import { DevicesUnavailable, DevicesView, DeviceView } from "./devices.ts";
import {
  ApprovalRequested,
  CommandsTrustRequested,
  MemoryProposed,
  PlanRequested,
  SkillProposed,
  StoredEvent,
  TurnStatus,
  UserInputRequested,
} from "./events.ts";
import { GcReport, GcUnavailable } from "./gc.ts";
import { CommandId, ProjectId, TaskId, ThreadId, TurnId } from "./ids.ts";
import { AccessMode, Item, Quota, Usage } from "./items.ts";
import { MemoryView } from "./memory.ts";
import { HarnessId, InteractionMode, Route } from "./route.ts";
import { BudgetMode, CatalogModel, RouteDecision, TaskClass } from "./routing.ts";
import { SessionHit, SessionQuery } from "./search.ts";
import { SkillHistoryEntry, SkillsView } from "./skills.ts";
import { SpendCap } from "./spend.ts";
import { RouteCost, TaskRating } from "./task.ts";
import { TerminalFeed, TerminalId, TerminalSize, TerminalUnavailable, TerminalView } from "./terminal.ts";
import { TrustedCommands } from "./trust.ts";
import { WorktreeView } from "./worktree.ts";

export class CommandRejected extends Schema.TaggedError<CommandRejected>()("CommandRejected", {
  reason: Schema.Literals([
    "ThreadNotFound",
    "ThreadExists",
    "ThreadBusy",
    "TurnNotRunning",
    "TurnVerifying",
    "RequestNotPending",
    "InvalidResolution",
    "InvalidProjectPath",
    "InvalidPolicy",
    "NoRoute",
    "InvalidSpendCaps",
    "SpendCapReached",
    "SpendCapNotSet",
    "ThreadArchived",
    "InvalidAttachment",
    "WorktreeUnavailable",
    "TurnNotFound",
    "InvalidRevert",
    "MemoryRejected",
    "MemoryFull",
    "MemoryNotFound",
    "InvalidPin",
    "TaskNotFound",
    "InvalidSkill",
    "SkillRejected",
    "SkillNotArchived",
    "SkillPinned",
    "SkillNotPinned",
    "SkillChangeNotFound",
    "ReviewSkipped",
    "HandoffSkipped",
    "CommandsNotTrusted",
    "DeviceExists",
    "DeviceNotFound",
  ]),
  message: Schema.String,
}) {}

/** Why a thread's spend caps can't be shown. The message names the cause and the fix. */
export class SpendCapsUnavailable extends Schema.TaggedError<SpendCapsUnavailable>()("SpendCapsUnavailable", {
  reason: Schema.Literals(["ThreadNotFound", "InvalidSpendCaps"]),
  message: Schema.String,
}) {}

/** Why routing can't be explained or simulated. The message names the cause and the fix. */
export class RoutingUnavailable extends Schema.TaggedError<RoutingUnavailable>()("RoutingUnavailable", {
  reason: Schema.Literals(["ThreadNotFound", "TaskNotFound", "InvalidPolicy", "NoRoute", "InvalidPin"]),
  message: Schema.String,
}) {}

/** Why the OS folder dialog couldn't open. The message names the cause and the fix. */
export class FolderPickUnavailable extends Schema.TaggedError<FolderPickUnavailable>()("FolderPickUnavailable", {
  reason: Schema.Literals(["NoDialog", "DialogFailed"]),
  message: Schema.String,
}) {}

/** Why a diff can't be shown. The message names the cause and the fix. */
export class DiffUnavailable extends Schema.TaggedError<DiffUnavailable>()("DiffUnavailable", {
  reason: Schema.Literals(["ThreadNotFound", "TurnNotFound", "NotAGitRepo", "NoCheckpoint", "GitFailed"]),
  message: Schema.String,
}) {}

/** One file's unified diff, `path` relative to the project. `truncated`: `diff` was cut to keep the payload small. */
export const FileDiff = Schema.Struct({ path: Schema.String, diff: Schema.String, truncated: Schema.Boolean });
export type FileDiff = typeof FileDiff.Type;

/**
 * Changed files between two checkpoints of the project, or a checkpoint and the working tree (ADR 0015).
 * `omittedFiles` counts changed files left out once the payload hit its size limit.
 */
export const DiffView = Schema.Struct({ files: Schema.Array(FileDiff), omittedFiles: Schema.Number });
export type DiffView = typeof DiffView.Type;

export const Receipt = Schema.Struct({ commandId: CommandId, seq: Schema.Number });
export type Receipt = typeof Receipt.Type;

export const TurnView = Schema.Struct({
  turnId: TurnId,
  text: Schema.String,
  mode: InteractionMode,
  /** Sent with the turn; fetch an image's bytes from `/attachments/<id>`. */
  attachments: Schema.Array(AttachmentRef),
  status: Schema.Literals(["running", ...TurnStatus.literals]),
  /** The user reverted the thread to an earlier turn: this one stays in the log, out of the conversation. */
  reverted: Schema.Boolean,
  items: Schema.Array(Item),
  /** One entry per model the turn used, in the order they were recorded. */
  usage: Schema.Array(Usage),
  error: Schema.optionalKey(Schema.String),
});
export type TurnView = typeof TurnView.Type;

/**
 * A route change between turns: `afterTurns` turns had started when it was made, at `at` (ISO). `by: "user"` pins the
 * thread; `by: "router"` is a de-escalation of the running task (DESIGN §8.7), and `reason` says why.
 */
export const RouteChange = Schema.Struct({
  from: Route,
  to: Route,
  by: Schema.Literals(["user", "router"]),
  reason: Schema.optionalKey(Schema.String),
  at: Schema.String,
  afterTurns: Schema.Number,
});
export type RouteChange = typeof RouteChange.Type;

export const ThreadView = Schema.Struct({
  threadId: ThreadId,
  projectPath: Schema.String,
  route: Route,
  /** True when the user picked the route; false when the router picks each new task's. */
  pinned: Schema.Boolean,
  /** Put away by the user: it takes no turns until unarchived. */
  archived: Schema.Boolean,
  /** The budget mode the user set for this thread's tasks; null when the policy's applies. */
  budgetMode: Schema.NullOr(BudgetMode),
  /**
   * The task the next turn continues, and why it runs on `route`; null when the next turn starts a new
   * one. `source` and `reason` are absent on tasks from before routing.
   */
  task: Schema.NullOr(
    Schema.Struct({
      taskId: TaskId,
      source: Schema.optionalKey(RouteDecision.fields.source),
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
  /** The thread's tasks, oldest first. Each starts with the turn its `taskId` names, and runs until the next one starts. */
  tasks: Schema.Array(Schema.Struct({ taskId: TaskId, rating: Schema.NullOr(TaskRating) })),
  sessionId: Schema.NullOr(Schema.String),
  /**
   * The thread's latest revert, until its next turn starts: `undone` once the user undid it. `files` says
   * whether the files were reverted too; `filesError` why restoring them failed. `whole` when it restored the whole
   * folder, the user's own edits too, since a reverted turn had no checkpoints; `outside`, files the reverted turns
   * changed outside the thread's folder, which it didn't restore.
   */
  revert: Schema.NullOr(
    Schema.Struct({
      toTurnId: TurnId,
      files: Schema.Boolean,
      undone: Schema.Boolean,
      filesError: Schema.optionalKey(Schema.String),
      whole: Schema.optionalKey(Schema.Boolean),
      outside: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  /** The git worktree the thread runs in; null when it runs in the project folder itself. */
  worktree: Schema.NullOr(WorktreeView),
  busy: Schema.Boolean,
  turns: Schema.Array(TurnView),
  /** Oldest first, so a client can show each between the turns it came between. */
  routeChanges: Schema.Array(RouteChange),
  /**
   * Requests still waiting for an answer, oldest first, so a client that reconnects can answer them. A background
   * review's proposals (`memory.proposed`, and `skill.proposed` on a turn that has ended) wait here too (DESIGN §14.5).
   */
  pendingRequests: Schema.Array(
    Schema.Union([ApprovalRequested, UserInputRequested, PlanRequested, SkillProposed, MemoryProposed, CommandsTrustRequested]),
  ),
});
export type ThreadView = typeof ThreadView.Type;

export const ThreadFeed = Schema.Union([
  /** `seq` is the last event the snapshot includes; later events follow in order. */
  Schema.Struct({ kind: Schema.Literal("snapshot"), thread: ThreadView, seq: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("event"), stored: StoredEvent }),
  Schema.Struct({ kind: Schema.Literal("delta"), turnId: TurnId, text: Schema.String }),
]);
export type ThreadFeed = typeof ThreadFeed.Type;

export const ProjectSummary = Schema.Struct({ projectId: ProjectId, path: Schema.String });
export type ProjectSummary = typeof ProjectSummary.Type;

/** One sidebar line: small on purpose, since it is resent whenever a turn starts or ends. */
export const ThreadSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  /** The first turn's text, cut to one short line; empty until the first turn. */
  title: Schema.String,
  busy: Schema.Boolean,
  /** Put away by the user. The projects feed leaves archived threads out unless asked for them. */
  archived: Schema.Boolean,
  /** When the thread was created or a turn last started or ended, as an ISO timestamp. */
  lastActivityAt: Schema.String,
  route: Route,
  /**
   * The thread's usage in USD, kept apart by access mode and never summed: metered is what was paid,
   * subscription is what the plan covered, valued at API prices by the harness.
   */
  cost: Schema.Struct({ meteredUsd: Schema.Number, subscriptionUsd: Schema.Number }),
});
export type ThreadSummary = typeof ThreadSummary.Type;

/** A harness's subscription window as it last reported it, at `at` (ISO). */
export const QuotaView = Schema.Struct({ harness: HarnessId, quota: Quota, at: Schema.String });
export type QuotaView = typeof QuotaView.Type;

/** Usage in USD kept apart by access mode, never summed: metered was paid, subscription is what the plan covered, at API prices. */
export const SpendSplit = Schema.Struct({ meteredUsd: Schema.Number, subscriptionUsd: Schema.Number });
export type SpendSplit = typeof SpendSplit.Type;

/** What `UsageQuery` covers: one project or all, over the last `days` local days including today, or all time. */
export const UsageFilter = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  days: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
});
export type UsageFilter = typeof UsageFilter.Type;

/**
 * The spend dashboard's totals (DESIGN §8.9, §12), computed by verdandid so the payload stays small. Spend
 * counts usage recorded in the period; task figures count tasks started in it.
 */
export const UsageReport = Schema.Struct({
  /** When the period began (ISO), or null for all time. */
  since: Schema.NullOr(Schema.String),
  spend: SpendSplit,
  /** One entry per local day (`2026-09-30`) that had usage, oldest first. */
  daily: Schema.Array(Schema.Struct({ day: Schema.String, ...SpendSplit.fields })),
  /** Each harness's subscription window as it last reported it. */
  quotas: Schema.Array(QuotaView),
  /** Cost per completed task by class, most spent first. `taskClass` is null for tasks from before routing. */
  byClass: Schema.Array(
    Schema.Struct({
      taskClass: Schema.NullOr(TaskClass),
      tasks: Schema.Int,
      completed: Schema.Int,
      /** Every task's cost, failed ones included, so dividing by `completed` gives cost per completed task. */
      cost: SpendSplit,
    }),
  ),
  /** How usage splits across models and access modes, most spent first. */
  byTarget: Schema.Array(
    Schema.Struct({
      model: Schema.String,
      accessMode: AccessMode,
      inputTokens: Schema.Number,
      outputTokens: Schema.Number,
      cacheReadTokens: Schema.Number,
      cacheWriteTokens: Schema.Number,
      costUsd: Schema.Number,
    }),
  ),
  /** Tasks the user moved to another route, and tasks the router escalated. */
  rates: Schema.Struct({ tasks: Schema.Int, overridden: Schema.Int, escalated: Schema.Int }),
  /**
   * An estimate, never a measurement: the same tasks' recorded tokens priced at `baseline`'s list price,
   * against what they were recorded as costing (subscription usage valued at API prices). Positive `savedUsd` is saved.
   */
  savings: Schema.Struct({
    estimate: Schema.Literal(true),
    baseline: Schema.String,
    tasks: Schema.Int,
    completed: Schema.Int,
    actualUsd: Schema.Number,
    baselineUsd: Schema.Number,
    savedUsd: Schema.Number,
  }),
});
export type UsageReport = typeof UsageReport.Type;

export const ProjectsFeed = Schema.Union([
  /** Threads most recently active first. `seq` is the last event the snapshot includes. */
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    projects: Schema.Array(ProjectSummary),
    threads: Schema.Array(ThreadSummary),
    /** The profile's workspace folder: where a thread without a project runs, and its project's path once it has one. */
    workspace: Schema.String,
    /** One per harness that has reported a subscription window. */
    quotas: Schema.Array(QuotaView),
    seq: Schema.Number,
  }),
  /** A thread was created or changed; it replaces the client's copy. `project` comes with a new thread. */
  Schema.Struct({ kind: Schema.Literal("thread"), thread: ThreadSummary, project: Schema.optionalKey(ProjectSummary), seq: Schema.Number }),
  /** A harness reported a changed subscription window; it replaces the client's copy for that harness. */
  Schema.Struct({ kind: Schema.Literal("quota"), quota: QuotaView, seq: Schema.Number }),
]);
export type ProjectsFeed = typeof ProjectsFeed.Type;

/**
 * The client API. Feeds are long-lived: a client ends one with Unsubscribe, never by
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
  /**
   * Every project and thread summary. Archived threads are left out of the snapshot unless `archived` is true;
   * a thread archived later still arrives, marked, so a client can drop it.
   */
  Rpc.make("ProjectsSubscribe", {
    payload: { subscriptionId: Schema.String, archived: Schema.optionalKey(Schema.Boolean) },
    success: ProjectsFeed,
    stream: true,
  }),
  /** Ends the feed started with `subscriptionId`, whichever kind it is. */
  Rpc.make("Unsubscribe", { payload: { subscriptionId: Schema.String } }),
  /** The harnesses this verdandid runs, so clients offer only those. */
  Rpc.make("HarnessesList", { success: Schema.Array(HarnessId) }),
  /**
   * The catalog's models on the harnesses this verdandid runs, with their effort levels: the names a message can pin its
   * task to with `@name`, and the route picker's choices.
   */
  Rpc.make("ModelsList", { success: Schema.Array(CatalogModel) }),
  /**
   * Opens the OS folder dialog on verdandid's machine and answers with the chosen folder's path, or null when the user
   * cancels. A browser can't give a page a folder's full path, so the dialog is verdandid's.
   */
  Rpc.make("FolderPick", { success: Schema.NullOr(Schema.String), error: FolderPickUnavailable }),
  /** What `turnId` changed in the project, or without it, everything since the thread's first turn. */
  Rpc.make("DiffGet", {
    payload: { threadId: ThreadId, turnId: Schema.optionalKey(TurnId) },
    success: DiffView,
    error: DiffUnavailable,
  }),
  /** Cost per completed task on each route that ran one, most spent first. */
  Rpc.make("TaskCostsList", { success: Schema.Array(RouteCost) }),
  /** The spend dashboard's totals for one project or all, over a period. */
  Rpc.make("UsageQuery", { payload: UsageFilter, success: UsageReport }),
  /** The spend caps over the thread's project and profile, with what they've spent this period; empty when none are set. */
  Rpc.make("SpendCapsGet", { payload: { threadId: ThreadId }, success: Schema.Array(SpendCap), error: SpendCapsUnavailable }),
  /**
   * Smart approvals of native terminal commands (DESIGN §17): `enabled` when the profile's `approvals.yaml` turns them
   * on, and `on` while the user hasn't turned them off since (`approvals.smart.set`). Only both together rate commands.
   */
  Rpc.make("ApprovalsGet", { success: Schema.Struct({ enabled: Schema.Boolean, on: Schema.Boolean }) }),
  /** A task's routing decision: its reason, trace and the classification behind it. */
  Rpc.make("RoutingExplain", { payload: { taskId: TaskId }, success: RouteDecision, error: RoutingUnavailable }),
  /**
   * What the router would pick if `text`, with `images` attached, started a new task in the thread, for the composer's live preview.
   * Pure and stores nothing; a pinned thread gets its pin back, and a leading `@name` its model.
   */
  Rpc.make("RoutingSimulate", {
    payload: { threadId: ThreadId, text: Schema.String, mode: InteractionMode, images: Schema.optionalKey(Schema.Int) },
    success: RouteDecision,
    error: RoutingUnavailable,
  }),
  /** What Verdandi remembers for the thread's user and project, for the Memory panel. */
  Rpc.make("MemoryList", { payload: { threadId: ThreadId }, success: MemoryView, error: CommandRejected }),
  /** The profile's skills and those in its read-only extra folders, for the Skills panel (DESIGN §14.4). */
  Rpc.make("SkillsList", { success: SkillsView }),
  /** The changes written to profile skill `skill`, newest first, each with why reverting it now would be refused, for the Skills panel. */
  Rpc.make("SkillHistoryGet", { payload: { skill: Schema.String }, success: Schema.Array(SkillHistoryEntry) }),
  /** The command lists the user trusted, in thread `threadId`'s project or in all, newest first; each one's thread revokes it. */
  Rpc.make("TrustedCommandsList", { payload: { threadId: Schema.optionalKey(ThreadId) }, success: Schema.Array(TrustedCommands) }),
  /**
   * Past sessions' messages containing `query` (DESIGN §14.3, ADR 0006), newest first, at most 50. A query
   * under 3 characters matches nothing.
   */
  Rpc.make("SessionSearch", { payload: SessionQuery, success: Schema.Array(SessionHit) }),
  /** Runs the cleanup policy now (ADR 0021): with `dryRun`, only says what it would remove. */
  Rpc.make("Gc", { payload: { dryRun: Schema.Boolean }, success: GcReport, error: GcUnavailable }),
  /** Starts a shell in a PTY, in the folder the thread runs in. It runs until closed, a page reload included. */
  Rpc.make("TerminalOpen", { payload: { threadId: ThreadId, ...TerminalSize }, success: TerminalView, error: TerminalUnavailable }),
  /** The thread's terminals, oldest first, so a reloaded page can reattach to them. */
  Rpc.make("TerminalList", { payload: { threadId: ThreadId }, success: Schema.Array(TerminalView) }),
  /** Types into the terminal: keystrokes or a paste, as the terminal emulator encodes them. */
  Rpc.make("TerminalWrite", {
    payload: { terminalId: TerminalId, data: Schema.String.check(Schema.isMaxLength(1024 * 1024)) },
    error: TerminalUnavailable,
  }),
  Rpc.make("TerminalResize", { payload: { terminalId: TerminalId, ...TerminalSize }, error: TerminalUnavailable }),
  /** Kills the shell and its process tree, then forgets the terminal. Answers once the shell is gone. */
  Rpc.make("TerminalClose", { payload: { terminalId: TerminalId }, error: TerminalUnavailable }),
  /** The terminal's kept output, then its live output. The server ends it when the terminal is closed. */
  /** Paired devices and waiting pairing requests, then both again whenever either changes (ADR 0028). */
  Rpc.make("DevicesSubscribe", { payload: { subscriptionId: Schema.String }, success: DevicesView, stream: true }),
  Rpc.make("DevicesList", { success: DevicesView }),
  /** Pairs the device that raised `requestId`: verdandid makes its token and hands it only to that device. */
  Rpc.make("DeviceApprove", { payload: { requestId: Schema.String }, success: DeviceView, error: DevicesUnavailable }),
  Rpc.make("DeviceDeny", { payload: { requestId: Schema.String }, error: DevicesUnavailable }),
  Rpc.make("TerminalSubscribe", {
    payload: { terminalId: TerminalId, subscriptionId: Schema.String },
    success: TerminalFeed,
    error: TerminalUnavailable,
    stream: true,
  }),
) {}
