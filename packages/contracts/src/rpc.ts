import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { ClientCommand } from "./commands.ts";
import { ApprovalRequested, PlanRequested, StoredEvent, TurnStatus, UserInputRequested } from "./events.ts";
import { CommandId, ProjectId, TaskId, ThreadId, TurnId } from "./ids.ts";
import { Item, Quota, Usage } from "./items.ts";
import { HarnessId, InteractionMode, Route } from "./route.ts";
import { RouteDecision } from "./routing.ts";
import { RouteCost } from "./task.ts";

export class CommandRejected extends Schema.TaggedError<CommandRejected>()("CommandRejected", {
  reason: Schema.Literals([
    "ThreadNotFound",
    "ThreadExists",
    "ThreadBusy",
    "TurnNotRunning",
    "RequestNotPending",
    "InvalidResolution",
    "InvalidProjectPath",
    "InvalidPolicy",
    "NoRoute",
  ]),
  message: Schema.String,
}) {}

/** Why routing can't be explained or simulated. The message names the cause and the fix. */
export class RoutingUnavailable extends Schema.TaggedError<RoutingUnavailable>()("RoutingUnavailable", {
  reason: Schema.Literals(["ThreadNotFound", "TaskNotFound", "InvalidPolicy", "NoRoute"]),
  message: Schema.String,
}) {}

/** Why a diff can't be shown. The message names the cause and the fix. */
export class DiffUnavailable extends Schema.TaggedError<DiffUnavailable>()("DiffUnavailable", {
  reason: Schema.Literals(["ThreadNotFound", "TurnNotFound", "NotAGitRepo", "GitFailed"]),
  message: Schema.String,
}) {}

/** One file's unified diff, `path` relative to the project. `truncated`: `diff` was cut to keep the payload small. */
export const FileDiff = Schema.Struct({ path: Schema.String, diff: Schema.String, truncated: Schema.Boolean });
export type FileDiff = typeof FileDiff.Type;

/**
 * The project's working tree against `HEAD` (ADR 0010). `omittedFiles` counts changed files left out
 * once the payload hit its size limit.
 */
export const DiffView = Schema.Struct({ files: Schema.Array(FileDiff), omittedFiles: Schema.Number });
export type DiffView = typeof DiffView.Type;

export const Receipt = Schema.Struct({ commandId: CommandId, seq: Schema.Number });
export type Receipt = typeof Receipt.Type;

export const TurnView = Schema.Struct({
  turnId: TurnId,
  text: Schema.String,
  mode: InteractionMode,
  status: Schema.Literals(["running", ...TurnStatus.literals]),
  items: Schema.Array(Item),
  /** One entry per model the turn used, in the order they were recorded. */
  usage: Schema.Array(Usage),
  error: Schema.optionalKey(Schema.String),
});
export type TurnView = typeof TurnView.Type;

/** A route change between turns: `afterTurns` turns had started when it was made, at `at` (ISO). */
export const RouteChange = Schema.Struct({
  from: Route,
  to: Route,
  by: Schema.Literal("user"),
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
  sessionId: Schema.NullOr(Schema.String),
  busy: Schema.Boolean,
  turns: Schema.Array(TurnView),
  /** Oldest first, so a client can show each between the turns it came between. */
  routeChanges: Schema.Array(RouteChange),
  /** Requests still waiting for an answer, oldest first, so a client that reconnects can answer them. */
  pendingRequests: Schema.Array(Schema.Union([ApprovalRequested, UserInputRequested, PlanRequested])),
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

export const ProjectsFeed = Schema.Union([
  /** Threads most recently active first. `seq` is the last event the snapshot includes. */
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    projects: Schema.Array(ProjectSummary),
    threads: Schema.Array(ThreadSummary),
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
  Rpc.make("ProjectsSubscribe", { payload: { subscriptionId: Schema.String }, success: ProjectsFeed, stream: true }),
  /** Ends the feed started with `subscriptionId`, whichever kind it is. */
  Rpc.make("Unsubscribe", { payload: { subscriptionId: Schema.String } }),
  /** The harnesses this verdandid runs, so clients offer only those. */
  Rpc.make("HarnessesList", { success: Schema.Array(HarnessId) }),
  /** The thread's project diff; with `turnId`, only the files that turn's file tools touched. */
  Rpc.make("DiffGet", {
    payload: { threadId: ThreadId, turnId: Schema.optionalKey(TurnId) },
    success: DiffView,
    error: DiffUnavailable,
  }),
  /** Cost per completed task on each route that ran one, most spent first. */
  Rpc.make("TaskCostsList", { success: Schema.Array(RouteCost) }),
  /** A task's routing decision: its reason, trace and the classification behind it. */
  Rpc.make("RoutingExplain", { payload: { taskId: TaskId }, success: RouteDecision, error: RoutingUnavailable }),
  /**
   * What the router would pick if `text` started a new task in the thread, for the composer's live preview.
   * Pure and stores nothing; a pinned thread gets its pin back.
   */
  Rpc.make("RoutingSimulate", {
    payload: { threadId: ThreadId, text: Schema.String, mode: InteractionMode },
    success: RouteDecision,
    error: RoutingUnavailable,
  }),
) {}
