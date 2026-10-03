import { Data, Effect, Schema } from "effect";
import { AttachmentRef } from "./attachments.ts";
import { DecisionAnswer, DecisionQuestion } from "./decisions.ts";
import { ProjectId, TaskId, ThreadId, TurnId } from "./ids.ts";
import { HandedSource, Item, Quota, UsageFields, VerifierRun } from "./items.ts";
import { MemoryScope } from "./memory.ts";
import { Question, Resolution } from "./requests.ts";
import { HarnessId, InteractionMode, Route } from "./route.ts";
import { BudgetMode, EscalationStep, EscalationTrigger, RouteDecision, RouteInputs } from "./routing.ts";
import { SkillAction, SkillChange, SkillState } from "./skills.ts";
import { CapPeriod, CapScope } from "./spend.ts";
import { TaskRating } from "./task.ts";
import { TrustPurpose } from "./trust.ts";

// Events are append-only and must stay readable forever. To change one, add a v2 schema
// next to v1 and upgrade v1 to v2 when it is read; never edit or delete a published version.

const v1 = Schema.Literal(1);

export const ThreadCreated = Schema.Struct({
  type: Schema.Literal("thread.created"),
  v: v1,
  threadId: ThreadId,
  projectId: ProjectId,
  projectPath: Schema.String,
  /** A placeholder until the first task is routed when `pinned` is false. */
  route: Route,
  /** False when the router picks each new task's route. Absent on threads from before routing: their route was always the user's. */
  pinned: Schema.optionalKey(Schema.Boolean),
});
/**
 * The user picked a route, which pins the thread to it from the next turn on. `by` records who changed
 * it, so overrides can be counted (DESIGN §8.8). `from` equals `to` when the user pins the routed route.
 */
export const ThreadRouteChanged = Schema.Struct({
  type: Schema.Literal("thread.route.changed"),
  v: v1,
  threadId: ThreadId,
  from: Route,
  to: Route,
  by: Schema.Literal("user"),
});
/**
 * A task (DESIGN §7) starts with the turn `taskId` names: a thread's first turn, and the first after a route
 * change. Committed right before that turn's `turn.started`; its turns run on `route`. v1 is read as v2 without `inputs`.
 */
const TaskStartedV1 = Schema.Struct({
  type: Schema.Literal("task.started"),
  v: v1,
  threadId: ThreadId,
  taskId: TaskId,
  route: Route,
  /** Why the task runs on `route`: the router's pick or the user's pin. Absent on tasks from before routing. */
  decision: Schema.optionalKey(RouteDecision),
});
export const TaskStarted = Schema.Struct({
  ...TaskStartedV1.fields,
  v: Schema.Literal(2),
  /** What the router read besides the turn's text and mode, for offline replay. Absent on v1 tasks, and when routing didn't run. */
  inputs: Schema.optionalKey(RouteInputs),
});
/** The user let the router pick again: the thread's next turn starts a routed task. */
export const ThreadRouteUnpinned = Schema.Struct({
  type: Schema.Literal("thread.route.unpinned"),
  v: v1,
  threadId: ThreadId,
});
/**
 * The user set the thread's budget mode, or cleared it back to the policy's (`null`). An unrouted
 * thread's next turn starts a new task routed under it; a pinned thread keeps it for when it's unpinned.
 */
export const ThreadBudgetChanged = Schema.Struct({
  type: Schema.Literal("thread.budget.changed"),
  v: v1,
  threadId: ThreadId,
  mode: Schema.NullOr(BudgetMode),
});
/** The user cleared the routing memory of `threadId`'s project: outcomes of tasks started before this no longer move routes. */
export const RoutingMemoryCleared = Schema.Struct({
  type: Schema.Literal("routing.memory.cleared"),
  v: v1,
  threadId: ThreadId,
  projectId: ProjectId,
});
/** The user rated task `taskId` of the thread, or cleared its rating (`null`). Its outcome copies the latest. */
export const TaskRated = Schema.Struct({
  type: Schema.Literal("task.rated"),
  v: v1,
  threadId: ThreadId,
  taskId: TaskId,
  rating: Schema.NullOr(TaskRating),
});
/** The user put the thread away: thread lists leave it out, and it takes no turns until unarchived. Nothing is deleted. */
export const ThreadArchived = Schema.Struct({
  type: Schema.Literal("thread.archived"),
  v: v1,
  threadId: ThreadId,
});
/** The user brought an archived thread back. */
export const ThreadUnarchived = Schema.Struct({
  type: Schema.Literal("thread.unarchived"),
  v: v1,
  threadId: ThreadId,
});
/** v1 is read as v2 without attachments. */
const TurnStartedV1 = Schema.Struct({
  type: Schema.Literal("turn.started"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  text: Schema.String,
  /** Absent on turns from before modes existed; those ran as `build`. */
  mode: Schema.optionalKey(InteractionMode),
});
export const TurnStarted = Schema.Struct({
  ...TurnStartedV1.fields,
  v: Schema.Literal(2),
  /** Images and files sent with the turn, as references to their stored bytes. Absent when there are none. */
  attachments: Schema.optionalKey(Schema.Array(AttachmentRef)),
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
/** The harness's subscription window changed. The projection keeps only each harness's latest. */
export const HarnessQuotaReported = Schema.Struct({
  type: Schema.Literal("harness.quota.reported"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  harness: HarnessId,
  quota: Quota,
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
  /**
   * Where approving moves the build: the router's pick for the task's class without its plan-mode route
   * (DESIGN §8.2 lever 3). Absent when the build stays on the thread's route, the thread is pinned, or the
   * plan came before this existed.
   */
  execute: Schema.optionalKey(RouteDecision),
});
/**
 * The user approved the plan of routed task `taskId`, and the router moved the rest of it to `to`, starting
 * with the running turn `turnId`. Committed right before that approval's `approval.resolved`, so the harness
 * switches before the agent's next step. Projected as a `route.switch` item of that turn.
 */
export const TaskRerouted = Schema.Struct({
  type: Schema.Literal("task.rerouted"),
  v: v1,
  threadId: ThreadId,
  taskId: TaskId,
  turnId: TurnId,
  from: Route,
  to: Route,
  decision: RouteDecision,
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
const DecisionRecordedV1 = Schema.Struct({
  type: Schema.Literal("decision.recorded"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  questions: Schema.Array(DecisionQuestion),
  /** One per question, in the same order. */
  answers: Schema.Array(DecisionAnswer),
});
/**
 * The decision layer answered questions about turn `turnId` (DESIGN §9.8), committed right before that turn's
 * `task.started` or `turn.started`. The turn's text is the state, kept only in its `turn.started`, unless `state`
 * holds what was asked about instead: a finished task's digest, asked about after its turn `turnId` (§14.5). Logged
 * for the lab, to measure other backends against the one that answered. v1 always read the turn's text.
 */
export const DecisionRecorded = Schema.Struct({
  ...DecisionRecordedV1.fields,
  v: Schema.Literal(2),
  state: Schema.optionalKey(Schema.String),
});
/**
 * The decision layer found task `taskId`'s turns up to `turnId` worth a background review (DESIGN §14.5): Verdandi
 * reviews `digest`, untrusted data, in review thread `reviewThreadId` of the same project.
 */
export const ReviewRequested = Schema.Struct({
  type: Schema.Literal("review.requested"),
  v: v1,
  threadId: ThreadId,
  taskId: TaskId,
  turnId: TurnId,
  reviewThreadId: ThreadId,
  projectPath: Schema.String,
  digest: Schema.String,
});
/**
 * Thread `threadId` is a background review of task `reviews.taskId` (DESIGN §14.5): hidden from thread lists, its one
 * turn runs as an `aux.review` task with no Verdandi tools and nobody to ask, and only spends metered dollars when
 * `allowMetered`. What it proposes goes to the reviewed thread.
 */
export const ReviewStarted = Schema.Struct({
  type: Schema.Literal("review.started"),
  v: v1,
  threadId: ThreadId,
  reviews: Schema.Struct({ threadId: ThreadId, taskId: TaskId, turnId: TurnId }),
  allowMetered: Schema.Boolean,
});
/**
 * The decision layer flagged `text` from `source` as a likely injection (DESIGN §17) before Verdandi handed it to
 * the agent: it went over anyway, under a warning. On turn `turnId`, the one that handed it over or, for an
 * escalation's, the turn it escalated from. `text` is untrusted data, kept as the decision's state for the lab.
 */
export const InjectionFlagged = Schema.Struct({
  type: Schema.Literal("injection.flagged"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  source: HandedSource,
  text: Schema.String,
  question: DecisionQuestion,
  answer: DecisionAnswer,
});
/** How an `injection.flagged` shows on its turn, the same in the projection, the web UI and trajectories. */
export const injectionItem = (e: typeof InjectionFlagged.Type): Extract<Item, { kind: "injection" }> => ({
  kind: "injection",
  source: e.source,
  why: e.answer.why ?? `the ${e.answer.backend} backend gave no reason`,
});
/**
 * The user raised a spend cap from `fromUsd` to `toUsd` for the rest of the period `periodKey` (DESIGN §8.9),
 * from thread `threadId`. `projectId` names the project a project cap covers.
 */
export const SpendCapRaised = Schema.Struct({
  type: Schema.Literal("spend.cap.raised"),
  v: v1,
  threadId: ThreadId,
  scope: CapScope,
  projectId: Schema.optionalKey(ProjectId),
  period: CapPeriod,
  periodKey: Schema.String,
  fromUsd: Schema.Number,
  toUsd: Schema.Number,
});
/**
 * Turn `turnId`'s agent finished after changing files, and Verdandi is about to run the project's verifiers before the
 * turn completes (DESIGN §8.7). From here the turn takes no more steers: its agent can't read them.
 */
export const VerifiersStarted = Schema.Struct({
  type: Schema.Literal("verifiers.started"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
});
/**
 * Verdandi ran one of the project's verifiers after turn `turnId`'s agent finished changing files, before the
 * turn completed. Projected as a `verifier` item of that turn; the task's outcome reads it (DESIGN §8.7, §8.8).
 */
export const VerifierRan = Schema.Struct({
  type: Schema.Literal("verifier.ran"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  ...VerifierRun.fields,
});
/** v1 escalations all came from a failed verifier: it reads as v2 with that `trigger`. */
const TaskEscalatedV1 = Schema.Struct({
  type: Schema.Literal("task.escalated"),
  v: v1,
  threadId: ThreadId,
  taskId: TaskId,
  turnId: TurnId,
  step: EscalationStep,
  from: Route,
  to: Schema.optionalKey(Route),
  nextTurnId: Schema.optionalKey(TurnId),
  reason: Schema.String,
});
/**
 * `trigger` fired after turn `turnId` of routed task `taskId` (a verifier failed, the agent reported it is blocked,
 * the same tool error repeated, or the user's next message corrected it), and Verdandi took one step of the escalation
 * ladder (DESIGN §8.7). At `effort` and `model` the task goes on at `to` with the turn `nextTurnId`, committed right
 * after this, which hands the agent the failure, its own report or the repeated error; after a correction it goes on
 * with the user's own turn, committed right after this, and there's no `nextTurnId`. At `ask` it stops and the user
 * decides. Projected as an `escalation` item of `turnId`.
 */
export const TaskEscalated = Schema.Struct({
  ...TaskEscalatedV1.fields,
  v: Schema.Literal(2),
  trigger: EscalationTrigger,
});
/**
 * Routed task `taskId`'s last turn passed its verifiers, and the turn `turnId` that goes on with it looks like mechanical
 * work, so the router moved the rest of the task to the cheaper `to` through the switch-cost gate (DESIGN §8.7). It stays
 * one task, on the same harness and session. Committed right before that turn's `turn.started`; projected as a route change
 * by the router, between the turns.
 */
export const TaskDeescalated = Schema.Struct({
  type: Schema.Literal("task.deescalated"),
  v: v1,
  threadId: ThreadId,
  taskId: TaskId,
  turnId: TurnId,
  from: Route,
  to: Route,
  decision: RouteDecision,
});
/** The thread asked for a worktree on `branch`: the reactor adds it, and the thread's next turn waits until it has. */
export const ThreadWorktreeRequested = Schema.Struct({
  type: Schema.Literal("thread.worktree.requested"),
  v: v1,
  threadId: ThreadId,
  branch: Schema.String,
});
/** The thread's worktree exists at `root`; its turns run in `path`, the project's folder inside it. */
export const ThreadWorktreeCreated = Schema.Struct({
  type: Schema.Literal("thread.worktree.created"),
  v: v1,
  threadId: ThreadId,
  root: Schema.String,
  path: Schema.String,
});
/** Adding (`create`) or removing (`remove`) the thread's worktree failed. A failed removal leaves it in place. */
export const ThreadWorktreeFailed = Schema.Struct({
  type: Schema.Literal("thread.worktree.failed"),
  v: v1,
  threadId: ThreadId,
  action: Schema.Literals(["create", "remove"]),
  error: Schema.String,
});
/** The project's setup command ran in the thread's new worktree. Its output is untrusted data. */
export const ThreadWorktreeSetupRan = Schema.Struct({
  type: Schema.Literal("thread.worktree.setup.ran"),
  v: v1,
  threadId: ThreadId,
  ...VerifierRun.fields,
});
/**
 * The project's setup command `command` wasn't run in the thread's new worktree, since the user hasn't trusted it for the
 * project: the thread's next turn asks first, and runs it if allowed.
 */
export const ThreadWorktreeSetupHeld = Schema.Struct({
  type: Schema.Literal("thread.worktree.setup.held"),
  v: v1,
  threadId: ThreadId,
  command: Schema.String,
});
/** The user asked to remove the thread's worktree, or archived the thread, or the cleanup policy did (ADR 0021). `force` removes it even with uncommitted changes. */
export const ThreadWorktreeRemovalRequested = Schema.Struct({
  type: Schema.Literal("thread.worktree.removal.requested"),
  v: v1,
  threadId: ThreadId,
  force: Schema.Boolean,
});
/** The thread's worktree is gone; its branch is kept. */
export const ThreadWorktreeRemoved = Schema.Struct({
  type: Schema.Literal("thread.worktree.removed"),
  v: v1,
  threadId: ThreadId,
});
/**
 * The user reverted the thread to the end of turn `toTurnId`: `turnIds`, the later turns still shown, are now
 * reverted, and the next turn forks the conversation from there (ADR 0004). It ends the running task, whose
 * outcome becomes `reverted`. With `files` the reactor restores the files from `toTurnId`'s end checkpoint.
 */
export const ThreadReverted = Schema.Struct({
  type: Schema.Literal("thread.reverted"),
  v: v1,
  threadId: ThreadId,
  toTurnId: TurnId,
  turnIds: Schema.Array(TurnId),
  files: Schema.Boolean,
});
/** The user undid the thread's latest revert: `turnIds` show again; with `restore`, the reactor puts back the files saved before it. */
export const ThreadRevertUndone = Schema.Struct({
  type: Schema.Literal("thread.revert.undone"),
  v: v1,
  threadId: ThreadId,
  turnIds: Schema.Array(TurnId),
  restore: Schema.optionalKey(Schema.String),
});
/** The reactor restored the thread's files from checkpoint `from`, after saving them as `saved`, or failed to (`error`). */
export const ThreadFilesRestored = Schema.Struct({
  type: Schema.Literal("thread.files.restored"),
  v: v1,
  threadId: ThreadId,
  from: Schema.String,
  saved: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
/**
 * The cleanup policy removed these checkpoint and revert refs of the thread (ADR 0021): the diffs of their turns,
 * reverts to them and undoing a revert they saved no longer work.
 */
export const ThreadCheckpointsRemoved = Schema.Struct({
  type: Schema.Literal("thread.checkpoints.removed"),
  v: v1,
  threadId: ThreadId,
  refs: Schema.Array(Schema.String),
});
/**
 * The agent of turn `turnId` said it can't finish task `taskId` as asked (`report_blocked`, DESIGN §8.7), for
 * `reason`. The escalation ladder reads it; projected as a `blocked` item of that turn.
 */
export const TaskBlocked = Schema.Struct({
  type: Schema.Literal("task.blocked"),
  v: v1,
  threadId: ThreadId,
  taskId: TaskId,
  turnId: TurnId,
  reason: Schema.String,
});
/**
 * A fact was remembered (DESIGN §14.2), from thread `threadId` (and its turn `turnId`, when the agent saved it),
 * in place of the entries `replaces` names. Saving a fact the store already has confirms that entry instead:
 * `entryId` is then the existing one's.
 */
export const MemorySaved = Schema.Struct({
  type: Schema.Literal("memory.saved"),
  v: v1,
  threadId: ThreadId,
  entryId: Schema.String,
  scope: MemoryScope,
  /** The project a project fact belongs to. */
  projectId: Schema.optionalKey(ProjectId),
  text: Schema.String,
  turnId: Schema.optionalKey(TurnId),
  replaces: Schema.Array(Schema.String),
});
/**
 * Review thread `reviewThreadId` proposes remembering `text` in the thread's `scope` memory, after its turn `turnId`
 * (DESIGN §14.5): a pending request until the user allows it, which records `memory.saved`, or denies it. Scanned
 * before it was recorded.
 */
export const MemoryProposed = Schema.Struct({
  type: Schema.Literal("memory.proposed"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  requestId: Schema.String,
  scope: MemoryScope,
  text: Schema.String,
  reviewThreadId: ThreadId,
});
/** The user rewrote remembered fact `entryId`. */
export const MemoryEdited = Schema.Struct({
  type: Schema.Literal("memory.edited"),
  v: v1,
  threadId: ThreadId,
  entryId: Schema.String,
  text: Schema.String,
});
/** The user forgot remembered fact `entryId`. */
export const MemoryDeleted = Schema.Struct({
  type: Schema.Literal("memory.deleted"),
  v: v1,
  threadId: ThreadId,
  entryId: Schema.String,
});
/**
 * Turn `turnId` starts a new harness session, which sees `text`, what Verdandi remembered then, at the head of
 * its first message (DESIGN §14.2). It stays the same for the session's life; saves show in the next one.
 */
export const MemorySnapshotTaken = Schema.Struct({
  type: Schema.Literal("memory.snapshot.taken"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  text: Schema.String,
});
/**
 * The agent of running turn `turnId` proposed `change` to a profile skill with `skill_manage` (DESIGN §14.4), and
 * waits for the user to allow or deny it with `approval.resolved`: a pending request, like an approval. Scanned
 * before it was recorded; nothing is written until it is allowed.
 */
export const SkillProposed = Schema.Struct({
  type: Schema.Literal("skill.proposed"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  requestId: Schema.String,
  change: SkillChange,
});
/**
 * The reactor wrote the allowed proposal `requestId` to the profile's skills folder, or `error` says why it
 * couldn't (the file changed since it was proposed, a guard refused the path). With `skill.proposed` and its
 * `approval.resolved`, the skill's provenance: who proposed what, in which turn, and who allowed it.
 */
export const SkillApplied = Schema.Struct({
  type: Schema.Literal("skill.applied"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  requestId: Schema.String,
  action: SkillAction,
  skill: Schema.String,
  path: Schema.String,
  error: Schema.optionalKey(Schema.String),
});
/**
 * Skill `skill`, which Verdandi created in thread `threadId`, moved from `from` to `to` (DESIGN §14.4): the daily
 * sweep staled or archived it for going unused, or the user restored it. Archived skills leave the folder Claude
 * Code loads for `<home>/skills-archive`, and come back on restore; the reactor moves them.
 */
export const SkillStateChanged = Schema.Struct({
  type: Schema.Literal("skill.state.changed"),
  v: v1,
  threadId: ThreadId,
  skill: Schema.String,
  from: SkillState,
  to: SkillState,
  by: Schema.Literals(["sweep", "user"]),
});
/**
 * verdandid would run the project's own `commands` (its verifiers or worktree setup, from `trustFiles`), which the user hasn't trusted for the
 * project, and asks first on running turn `turnId`: a pending request. Allowing it records `commands.trusted`; denying it
 * runs nothing. `hash` names the exact list, so a changed list asks again.
 */
export const CommandsTrustRequested = Schema.Struct({
  type: Schema.Literal("commands.trust.requested"),
  v: v1,
  threadId: ThreadId,
  turnId: TurnId,
  requestId: Schema.String,
  purpose: TrustPurpose,
  commands: Schema.Array(Schema.String),
  hash: Schema.String,
});
/** The user trusted command list `hash` in project `projectId`: verdandid runs it there without asking until revoked. */
export const CommandsTrusted = Schema.Struct({
  type: Schema.Literal("commands.trusted"),
  v: v1,
  threadId: ThreadId,
  projectId: ProjectId,
  purpose: TrustPurpose,
  commands: Schema.Array(Schema.String),
  hash: Schema.String,
});
/** The user revoked their trust in command list `hash` of project `projectId`: running it asks again. */
export const CommandsTrustRevoked = Schema.Struct({
  type: Schema.Literal("commands.trust.revoked"),
  v: v1,
  threadId: ThreadId,
  projectId: ProjectId,
  hash: Schema.String,
});
/** `limit`: a budget guard of the task (its `maxCost` or `maxTurns`) stopped the turn, which ends the task. */
export const TurnStatus = Schema.Literals(["success", "error", "interrupted", "limit"]);
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
  ThreadRouteUnpinned,
  ThreadBudgetChanged,
  RoutingMemoryCleared,
  TaskRated,
  ThreadArchived,
  ThreadUnarchived,
  TaskStarted,
  TurnStarted,
  HarnessSessionBound,
  TurnItemAdded,
  TurnSteered,
  TurnUsageRecorded,
  HarnessQuotaReported,
  ApprovalRequested,
  UserInputRequested,
  PlanRequested,
  TaskRerouted,
  ApprovalResolved,
  TurnCompleted,
  DecisionRecorded,
  ReviewRequested,
  ReviewStarted,
  InjectionFlagged,
  SpendCapRaised,
  VerifiersStarted,
  VerifierRan,
  TaskEscalated,
  TaskDeescalated,
  ThreadWorktreeRequested,
  ThreadWorktreeCreated,
  ThreadWorktreeFailed,
  ThreadWorktreeSetupRan,
  ThreadWorktreeSetupHeld,
  ThreadWorktreeRemovalRequested,
  ThreadWorktreeRemoved,
  ThreadReverted,
  ThreadRevertUndone,
  ThreadFilesRestored,
  ThreadCheckpointsRemoved,
  TaskBlocked,
  MemorySaved,
  MemoryProposed,
  MemoryEdited,
  MemoryDeleted,
  MemorySnapshotTaken,
  SkillProposed,
  SkillApplied,
  SkillStateChanged,
  CommandsTrustRequested,
  CommandsTrusted,
  CommandsTrustRevoked,
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

/** Published versions that are no longer current, each with its upgrade to the current one. */
const upgrades: Record<string, (payload: string) => Effect.Effect<Event, Schema.SchemaError>> = {
  "task.started@1": (payload) =>
    Effect.map(Schema.decodeUnknownEffect(Schema.fromJsonString(TaskStartedV1))(payload), (e): Event => ({ ...e, v: 2 })),
  "turn.started@1": (payload) =>
    Effect.map(Schema.decodeUnknownEffect(Schema.fromJsonString(TurnStartedV1))(payload), (e): Event => ({ ...e, v: 2 })),
  "decision.recorded@1": (payload) =>
    Effect.map(Schema.decodeUnknownEffect(Schema.fromJsonString(DecisionRecordedV1))(payload), (e): Event => ({ ...e, v: 2 })),
  "task.escalated@1": (payload) =>
    Effect.map(
      Schema.decodeUnknownEffect(Schema.fromJsonString(TaskEscalatedV1))(payload),
      (e): Event => ({ ...e, v: 2, trigger: "verifier" }),
    ),
};

const byTypeAndVersion: Record<string, Schema.Codec<Event, unknown>> = {
  "thread.created@1": ThreadCreated,
  "thread.route.changed@1": ThreadRouteChanged,
  "thread.route.unpinned@1": ThreadRouteUnpinned,
  "thread.budget.changed@1": ThreadBudgetChanged,
  "routing.memory.cleared@1": RoutingMemoryCleared,
  "task.rated@1": TaskRated,
  "thread.archived@1": ThreadArchived,
  "thread.unarchived@1": ThreadUnarchived,
  "task.started@2": TaskStarted,
  "turn.started@2": TurnStarted,
  "harness.session.bound@1": HarnessSessionBound,
  "turn.item.added@1": TurnItemAdded,
  "turn.steered@1": TurnSteered,
  "turn.usage.recorded@1": TurnUsageRecorded,
  "harness.quota.reported@1": HarnessQuotaReported,
  "approval.requested@1": ApprovalRequested,
  "user-input.requested@1": UserInputRequested,
  "plan.requested@1": PlanRequested,
  "task.rerouted@1": TaskRerouted,
  "approval.resolved@1": ApprovalResolved,
  "turn.completed@1": TurnCompleted,
  "decision.recorded@2": DecisionRecorded,
  "review.requested@1": ReviewRequested,
  "review.started@1": ReviewStarted,
  "injection.flagged@1": InjectionFlagged,
  "spend.cap.raised@1": SpendCapRaised,
  "verifiers.started@1": VerifiersStarted,
  "verifier.ran@1": VerifierRan,
  "task.escalated@2": TaskEscalated,
  "task.deescalated@1": TaskDeescalated,
  "thread.worktree.requested@1": ThreadWorktreeRequested,
  "thread.worktree.created@1": ThreadWorktreeCreated,
  "thread.worktree.failed@1": ThreadWorktreeFailed,
  "thread.worktree.setup.ran@1": ThreadWorktreeSetupRan,
  "thread.worktree.setup.held@1": ThreadWorktreeSetupHeld,
  "thread.worktree.removal.requested@1": ThreadWorktreeRemovalRequested,
  "thread.worktree.removed@1": ThreadWorktreeRemoved,
  "thread.reverted@1": ThreadReverted,
  "thread.revert.undone@1": ThreadRevertUndone,
  "thread.files.restored@1": ThreadFilesRestored,
  "thread.checkpoints.removed@1": ThreadCheckpointsRemoved,
  "task.blocked@1": TaskBlocked,
  "memory.saved@1": MemorySaved,
  "memory.proposed@1": MemoryProposed,
  "memory.edited@1": MemoryEdited,
  "memory.deleted@1": MemoryDeleted,
  "memory.snapshot.taken@1": MemorySnapshotTaken,
  "skill.proposed@1": SkillProposed,
  "skill.applied@1": SkillApplied,
  "skill.state.changed@1": SkillStateChanged,
  "commands.trust.requested@1": CommandsTrustRequested,
  "commands.trusted@1": CommandsTrusted,
  "commands.trust.revoked@1": CommandsTrustRevoked,
};

/** The row shape an event is stored as. */
export type EventRow = { readonly type: string; readonly v: number; readonly payload: string };

export const encodeEvent = (event: Event): EventRow => ({ type: event.type, v: event.v, payload: JSON.stringify(event) });

export const decodeStoredEvent = (row: EventRow): Effect.Effect<Event, EventDecodeError> => {
  const upgrade = upgrades[`${row.type}@${row.v}`];
  const schema = byTypeAndVersion[`${row.type}@${row.v}`];
  if (!schema && !upgrade) {
    return Effect.fail(
      new EventDecodeError({
        message: `Stored event ${row.type} v${row.v} is newer than this build of Verdandi understands. Update Verdandi to read this database.`,
      }),
    );
  }
  return (
    upgrade ? upgrade(row.payload) : Schema.decodeUnknownEffect(Schema.fromJsonString(schema as Schema.Codec<Event, unknown>))(row.payload)
  ).pipe(Effect.mapError((e) => new EventDecodeError({ message: `Stored event ${row.type} v${row.v} is malformed: ${e.message}` })));
};
