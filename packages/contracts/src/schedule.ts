import { Schema } from "effect";
import { ThreadId } from "./ids.ts";
import { InteractionMode } from "./route.ts";
import { SpendSplit } from "./rpc.ts";

/**
 * A job `verdandi schedule add` registered with the OS scheduler, saved as `<home>/schedules/<name>.json`. Each time
 * it fires it runs `verdandi run --deny-requests --json` with these arguments, on a new thread in `folder`.
 */
export const ScheduledJob = Schema.Struct({
  v: Schema.Literal(1),
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][\w-]{0,63}$/)),
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
 * One firing of a scheduled job, a line of `<home>/schedules/<name>.log`. `exitCode` is `verdandi run`'s (null when
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
