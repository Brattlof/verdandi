import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  Command,
  CommandId,
  CommandRejected,
  JobId,
  Receipt,
  RunStatus,
  StoredEvent,
  ThreadId,
  TurnId,
  TurnView,
} from "@verdandi/contracts";
import { Effect } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import type { ScheduledRun } from "../event-store/decider.ts";
import { loadJob } from "./schedule-store.ts";

type Dispatch = (command: Command) => Effect.Effect<Receipt, CommandRejected | SqlError.SqlError>;
type Claimed = Extract<StoredEvent["event"], { type: "schedule.occurrence.claimed" }>;
type TurnStatus = TurnView["status"];

const runStatus: Record<TurnStatus, RunStatus | undefined> = {
  running: undefined,
  success: "ok",
  error: "error",
  interrupted: "error",
  limit: "limit",
};

/**
 * How a scheduled job's runs start and end (DESIGN §15, ADR 0032). A claimed occurrence starts a thread of its own in
 * the job's project, or the workspace (`workspace`), and Verdandi sends its turn there. The run ends when its task
 * stops: its last turn's status, or the rejection of its turn.
 */
export const makeScheduleRuns = (dispatch: Dispatch, sql: SqlClient.SqlClient, workspace: string) => {
  const report = (owner: ThreadId, jobId: JobId, scheduledInstant: string, status: RunStatus, error?: string) =>
    dispatch({
      type: "schedule.run.report",
      commandId: randomUUID() as CommandId,
      threadId: owner,
      jobId,
      scheduledInstant,
      status,
      ...(error !== undefined && { error }),
    }).pipe(Effect.asVoid);

  /** Starts claimed occurrence `e`'s thread and sends the job's turn as Verdandi's; a refused turn is the run's result. */
  const start = (e: Claimed) =>
    Effect.gen(function* () {
      const found = yield* loadJob(e.jobId);
      if (!found || found.state === "paused") return;
      const { job } = found;
      const projectPath = job.project ?? workspace;
      if (!existsSync(projectPath))
        return yield* report(
          e.threadId,
          e.jobId,
          e.scheduledInstant,
          "error",
          `The job's folder ${projectPath} doesn't exist. Remove the job and add it again for a folder that does.`,
        );
      const started = dispatch({
        type: "schedule.run.start",
        commandId: randomUUID() as CommandId,
        threadId: e.runThreadId,
        jobId: e.jobId,
        name: job.name,
        ownerThreadId: e.threadId,
        scheduledInstant: e.scheduledInstant,
        projectPath,
        ...(job.route && { route: job.route }),
        ...(job.limits && { limits: job.limits }),
        worktree: job.worktree,
      }).pipe(
        Effect.andThen(
          dispatch({
            type: "turn.send",
            commandId: randomUUID() as CommandId,
            threadId: e.runThreadId,
            turnId: randomUUID() as TurnId,
            text: job.text,
            mode: job.mode,
          }),
        ),
      );
      yield* started.pipe(
        Effect.catchTag("CommandRejected", (rejected) => report(e.threadId, e.jobId, e.scheduledInstant, "error", rejected.message)),
      );
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchCause((cause) => Effect.logWarning(`Could not start the run of job ${e.jobId} due at ${e.scheduledInstant}.`, cause)),
    );

  /**
   * Reports the end of the run thread `threadId` holds, once its task has stopped: nothing runs there, so no
   * escalation's turn follows. Its status is its last turn's, or `error` when a verifier failed on that turn.
   */
  const settle = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const [thread] = yield* sql<{ schedule: string | null; running: string | null }>`
        select schedule, running_turn_id as running from threads where id = ${threadId}`;
      if (!thread?.schedule || thread.running) return;
      const run = JSON.parse(thread.schedule) as ScheduledRun;
      const [last] = yield* sql<{ status: TurnStatus; error: string | null; failed: string | null }>`
        select n.status, n.error, (select json_extract(i.payload, '$.command') from items i
            where i.turn_id = n.id and json_extract(i.payload, '$.kind') = 'verifier' and not json_extract(i.payload, '$.passed')
            limit 1) as failed
        from turns n where n.thread_id = ${threadId} order by n.started_at desc, n.rowid desc limit 1`;
      const ended = last && runStatus[last.status];
      if (!last || !ended) return;
      const error = last.failed ? `The verifier \`${last.failed}\` failed.` : (last.error ?? undefined);
      const status = last.failed && ended === "ok" ? "error" : ended;
      yield* report(run.ownerThreadId, run.jobId, run.scheduledInstant, status, error);
    }).pipe(Effect.catchCause((cause) => Effect.logWarning(`Could not record how the scheduled run in thread ${threadId} ended.`, cause)));

  /**
   * Runs a stopped verdandid left unfinished: ended now, from their thread's last turn, or as never started. Never
   * started again: an occurrence runs at most once.
   */
  const recover = Effect.gen(function* () {
    const stale = yield* sql<{ job_id: JobId; scheduled_instant: string; owner: ThreadId; thread: ThreadId | null; turns: number }>`
      select r.job_id, r.scheduled_instant, s.owner_thread_id as owner, t.id as thread,
        (select count(*) from turns n where n.thread_id = t.id) as turns
      from schedule_runs r join schedules s on s.id = r.job_id left join threads t on t.id = r.thread_id
      where r.status = 'running' and s.state != 'removed' and t.running_turn_id is null`;
    yield* Effect.forEach(
      stale,
      (r) =>
        r.thread && r.turns > 0
          ? settle(r.thread)
          : report(r.owner, r.job_id, r.scheduled_instant, "error", "verdandid stopped before this run started; it isn't run again.").pipe(
              Effect.catchCause((cause) => Effect.logWarning(`Could not end the run of job ${r.job_id} a stopped verdandid left.`, cause)),
            ),
      { discard: true },
    );
  });

  return { start, settle, recover };
};
