import type { Command, JobId, JobRunView, JobSpec, JobView, ThreadId } from "@verdandi/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { DeciderState, JobRow } from "../event-store/decider.ts";

type JobRecord = {
  id: JobId;
  owner_thread_id: ThreadId;
  job: string;
  state: JobRow["state"];
  next_run_at: string | null;
  created_at: string;
};

const jobRow = (r: JobRecord): JobRow => ({
  jobId: r.id,
  ownerThreadId: r.owner_thread_id,
  job: JSON.parse(r.job) as JobSpec,
  state: r.state,
  nextRunAt: r.next_run_at,
});

/** What the decider needs for a `schedule.*` command (`DeciderState.schedule`), at `now`. */
export const loadScheduleState = (command: Extract<Command, { type: `schedule.${string}` }>, now: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [job] = yield* sql<JobRecord>`select * from schedules where id = ${command.jobId} and state != 'removed'`;
    const nameTaken =
      command.type === "schedule.create" &&
      (yield* sql`select 1 from schedules where name = ${command.job.name} and state != 'removed'`).length > 0;
    const [run] =
      command.type === "schedule.run.report"
        ? yield* sql<{ status: string }>`select status from schedule_runs
            where job_id = ${command.jobId} and scheduled_instant = ${command.scheduledInstant}`
        : [];
    return { now, job: job ? jobRow(job) : null, nameTaken, runStatus: run?.status ?? null } satisfies DeciderState["schedule"];
  });

/** A job by id, removed or not, for the reactor that starts its runs. */
export const loadJob = (jobId: string) =>
  Effect.gen(function* () {
    const [r] = yield* (yield* SqlClient.SqlClient)<JobRecord>`select * from schedules where id = ${jobId}`;
    return r ? jobRow(r) : undefined;
  });

/** Every job but removed ones, by name, each with its latest `runs` occurrences, newest first. */
export const loadJobs = (runs = 20) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const jobs = yield* sql<JobRecord>`select * from schedules where state != 'removed' order by name`;
    return yield* Effect.forEach(jobs, (r) =>
      Effect.map(
        sql<{
          scheduled_instant: string;
          status: JobRunView["status"];
          thread_id: ThreadId | null;
          at: string;
          ended_at: string | null;
          note: string | null;
        }>`select scheduled_instant, status, thread_id, at, ended_at, note from schedule_runs
          where job_id = ${r.id} order by scheduled_instant desc limit ${runs}`,
        (rows): JobView => {
          const { jobId, ownerThreadId, job, state, nextRunAt } = jobRow(r);
          return {
            jobId,
            ownerThreadId,
            job,
            state,
            nextRunAt,
            createdAt: r.created_at,
            runs: rows.map((run) => ({
              scheduledInstant: run.scheduled_instant,
              status: run.status,
              threadId: run.thread_id,
              at: run.at,
              endedAt: run.ended_at,
              note: run.note,
            })),
          };
        },
      ),
    );
  });

/** The active job whose next run comes first, which the scheduler's one timer waits for. */
export const loadDueJob = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [due] = yield* sql<{ id: JobId; owner_thread_id: ThreadId; next_run_at: string }>`
    select id, owner_thread_id, next_run_at from schedules where state = 'active' and next_run_at is not null
    order by next_run_at limit 1`;
  return due;
});
