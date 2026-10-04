import { Schema } from "effect";
import { CommandId, ThreadId } from "./ids.ts";
import { InteractionMode, Route } from "./route.ts";
import { TaskLimits } from "./routing.ts";
import { SpendSplit } from "./spend.ts";

/**
 * Jobs verdandid's scheduler runs (DESIGN §15, ADR 0032). A job's events go on its owning thread's stream: the thread
 * that created it (the agent's, through `cronjob`) or the CLI's thread for the job's folder. Each occurrence it claims
 * starts a thread of its own, labelled with the job, whose one task Verdandi sends as an ordinary turn.
 */
export const JobId = Schema.String.pipe(Schema.brand("JobId"));
export type JobId = typeof JobId.Type;

export const JobName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][\w-]{0,63}$/));

/**
 * When a job runs: a 5-field cron expression or a nickname (`@daily`), read with `Bun.cron.parse` in IANA time zone
 * `tz`, or once at instant `at` (ISO). "In 2h" and plain language become one of these before the job is created.
 */
export const JobSchedule = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("cron"), cron: Schema.String, tz: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("once"), at: Schema.String }),
]);
export type JobSchedule = typeof JobSchedule.Type;

/**
 * What a job runs. `project` null runs it in the workspace (DESIGN §13). `route` absent lets the router pick each
 * run's route under the project's policy; `limits` tighten the task's own. `worktree` runs each run's thread in a
 * worktree of its own, never in the workspace. `missed`: what occurrences missed past the grace period become, one
 * run (`run`) or none (`skip`).
 */
export const JobSpec = Schema.Struct({
  name: JobName,
  project: Schema.NullOr(Schema.String),
  text: Schema.String,
  mode: InteractionMode,
  schedule: JobSchedule,
  route: Schema.optionalKey(Route),
  limits: Schema.optionalKey(TaskLimits),
  worktree: Schema.Boolean,
  missed: Schema.Literals(["run", "skip"]),
});
export type JobSpec = typeof JobSpec.Type;

/** How a run ended: its task completed (`ok`), failed or was interrupted (`error`), or stopped at a task limit. */
export const RunStatus = Schema.Literals(["ok", "error", "limit"]);
export type RunStatus = typeof RunStatus.Type;

const owned = { commandId: CommandId, threadId: ThreadId, jobId: JobId } as const;

/** Creates job `jobId`, owned by thread `threadId`. A scheduled run's thread can't create jobs. */
export const ScheduleCreate = Schema.Struct({ type: Schema.Literal("schedule.create"), ...owned, job: JobSpec });
export const SchedulePause = Schema.Struct({ type: Schema.Literal("schedule.pause"), ...owned });
/** Resumes a paused job from now on: what it missed while paused doesn't run. */
export const ScheduleResume = Schema.Struct({ type: Schema.Literal("schedule.resume"), ...owned });
/** Removes a job; its runs' threads stay. */
export const ScheduleRemove = Schema.Struct({ type: Schema.Literal("schedule.remove"), ...owned });
/**
 * Internal: the scheduler's timer reached the job's next run `scheduledInstant`. The decider claims it, at most once,
 * for a run on thread `runThreadId`, or skips it. Clients cannot send it.
 */
export const ScheduleFire = Schema.Struct({
  type: Schema.Literal("schedule.fire"),
  ...owned,
  scheduledInstant: Schema.String,
  runThreadId: ThreadId,
});
/** Internal: starts claimed occurrence `scheduledInstant`'s thread `threadId` in `projectPath`. */
export const ScheduleRunStart = Schema.Struct({
  type: Schema.Literal("schedule.run.start"),
  commandId: CommandId,
  threadId: ThreadId,
  jobId: JobId,
  name: JobName,
  ownerThreadId: ThreadId,
  scheduledInstant: Schema.String,
  projectPath: Schema.String,
  route: Schema.optionalKey(Route),
  limits: Schema.optionalKey(TaskLimits),
  worktree: Schema.Boolean,
});
/** Internal: how claimed occurrence `scheduledInstant`'s run ended, reported once its task stops or its turn was refused. */
export const ScheduleRunReport = Schema.Struct({
  type: Schema.Literal("schedule.run.report"),
  ...owned,
  scheduledInstant: Schema.String,
  status: RunStatus,
  error: Schema.optionalKey(Schema.String),
});

const v1 = Schema.Literal(1);
/** On the job's owning thread, naming the job, so the thread and the log read without a lookup. */
const onOwner = { v: v1, threadId: ThreadId, jobId: JobId, name: JobName } as const;

/** `nextRunAt`: its first occurrence (ISO), null when it never fires. */
export const ScheduleCreated = Schema.Struct({
  type: Schema.Literal("schedule.created"),
  v: v1,
  threadId: ThreadId,
  jobId: JobId,
  job: JobSpec,
  nextRunAt: Schema.NullOr(Schema.String),
});
export const SchedulePaused = Schema.Struct({ type: Schema.Literal("schedule.paused"), ...onOwner });
export const ScheduleResumed = Schema.Struct({
  type: Schema.Literal("schedule.resumed"),
  ...onOwner,
  nextRunAt: Schema.NullOr(Schema.String),
});
export const ScheduleRemoved = Schema.Struct({ type: Schema.Literal("schedule.removed"), ...onOwner });
/**
 * Occurrence `scheduledInstant` is claimed, at most once, for a run on thread `runThreadId`; the job's next run moves to
 * `nextRunAt` (null: it's done) in the same transaction.
 */
export const ScheduleOccurrenceClaimed = Schema.Struct({
  type: Schema.Literal("schedule.occurrence.claimed"),
  ...onOwner,
  scheduledInstant: Schema.String,
  runThreadId: ThreadId,
  nextRunAt: Schema.NullOr(Schema.String),
});
/** Every occurrence from `from` up to `until` (ISO) was skipped, for `reason`; the job's next run moves to `nextRunAt`. */
export const ScheduleOccurrenceSkipped = Schema.Struct({
  type: Schema.Literal("schedule.occurrence.skipped"),
  ...onOwner,
  from: Schema.String,
  until: Schema.String,
  reason: Schema.String,
  nextRunAt: Schema.NullOr(Schema.String),
});
/**
 * Thread `threadId` runs occurrence `scheduledInstant` of job `name`: nobody watches it, so its requests are denied at
 * once (ADR 0023), and its tasks run within `limits`.
 */
export const ScheduleRunStarted = Schema.Struct({
  type: Schema.Literal("schedule.run.started"),
  v: v1,
  threadId: ThreadId,
  jobId: JobId,
  name: JobName,
  ownerThreadId: ThreadId,
  scheduledInstant: Schema.String,
  limits: Schema.optionalKey(TaskLimits),
});
export const ScheduleRunEnded = Schema.Struct({
  type: Schema.Literal("schedule.run.ended"),
  ...onOwner,
  scheduledInstant: Schema.String,
  status: RunStatus,
  error: Schema.optionalKey(Schema.String),
});

/** What a run's thread shows: the job it runs, and which occurrence. */
export const ScheduleRunLabel = Schema.Struct({ jobId: JobId, name: JobName, scheduledInstant: Schema.String });
export type ScheduleRunLabel = typeof ScheduleRunLabel.Type;

/** One occurrence of a job: `running` until its run ends, or `skipped`, with why (`note`), or a run's error. */
export const JobRunView = Schema.Struct({
  scheduledInstant: Schema.String,
  status: Schema.Literals(["running", "skipped", ...RunStatus.literals]),
  threadId: Schema.NullOr(ThreadId),
  at: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
});
export type JobRunView = typeof JobRunView.Type;

/** A job as `SchedulesList` shows it, with its latest runs, newest first. `done`: a one-off that ran or was retired. */
export const JobView = Schema.Struct({
  jobId: JobId,
  ownerThreadId: ThreadId,
  job: JobSpec,
  state: Schema.Literals(["active", "paused", "done"]),
  nextRunAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  runs: Schema.Array(JobRunView),
});
export type JobView = typeof JobView.Type;

/**
 * A job `verdandi schedule add` registered with the OS scheduler before verdandid had its own (#209), saved as
 * `<home>/schedules/<name>.json`. Each time it fires it runs `verdandi run --deny-requests --json` with these
 * arguments; `verdandi schedule list` shows such entries so they can be removed.
 */
export const ScheduledJob = Schema.Struct({
  v: Schema.Literal(1),
  name: JobName,
  /** A 5-field cron expression or a nickname (`@daily`), in the machine's local time. */
  cron: Schema.String,
  task: Schema.String,
  /** The thread's folder: the project named when the job was added, or the folder `verdandi run` would have picked then. */
  folder: Schema.String,
  /** Runs each thread in a worktree of its own (`verdandi run --worktree`). */
  worktree: Schema.Boolean,
  mode: Schema.optionalKey(InteractionMode),
  /** `auto` or `harness/model/effort`, as `verdandi run --route` takes it. */
  route: Schema.optionalKey(Schema.String),
  /** `PATH` when the job was added: cron and launchd start jobs with a minimal one, where `claude` isn't found. */
  envPath: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
});
export type ScheduledJob = typeof ScheduledJob.Type;

/**
 * One firing of an OS scheduler job, a line of `<home>/schedules/<name>.log`. `exitCode` is `verdandi run`'s (null when
 * it couldn't be started); the rest comes from its `--json` object, absent when it printed none.
 */
export const ScheduledRun = Schema.Struct({
  v: Schema.Literal(1),
  at: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  threadId: Schema.optionalKey(ThreadId),
  status: Schema.optionalKey(Schema.Literals(["completed", "failed", "limit", "request", "interrupted"])),
  cost: Schema.optionalKey(SpendSplit),
  error: Schema.optionalKey(Schema.String),
});
export type ScheduledRun = typeof ScheduledRun.Type;
