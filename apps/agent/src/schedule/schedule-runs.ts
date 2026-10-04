import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type {
  Command,
  CommandId,
  CommandRejected,
  DecisionAnswer,
  JobId,
  JobSpec,
  Receipt,
  RunStatus,
  StoredEvent,
  ThreadId,
  TurnId,
  TurnView,
} from "@verdandi/contracts";
import { flagged } from "@verdandi/decisions";
import { Effect } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import type { ScheduledRun } from "../event-store/decider.ts";
import { runScript, type ScriptOutcome, withScriptOutput } from "./schedule-script.ts";
import { loadHeldRuns, loadJob } from "./schedule-store.ts";

type Dispatch = (command: Command) => Effect.Effect<Receipt, CommandRejected | SqlError.SqlError>;
type Claimed = Extract<StoredEvent["event"], { type: "schedule.occurrence.claimed" }>;
type Released = Extract<StoredEvent["event"], { type: "schedule.occurrence.released" }>;
type TurnStatus = TurnView["status"];

const runStatus: Record<TurnStatus, RunStatus | undefined> = {
  running: undefined,
  success: "ok",
  error: "error",
  interrupted: "error",
  limit: "limit",
};

/** Refusals of a run's turn that its job's setup causes, found before any model call: the run is `blocked_config`. */
const config: ReadonlySet<CommandRejected["reason"]> = new Set([
  "InvalidPolicy",
  "InvalidSpendCaps",
  "NoRoute",
  "InvalidPin",
  "MeteredNotAllowed",
]);

export type ScheduleRunsDeps = {
  readonly dispatch: Dispatch;
  readonly sql: SqlClient.SqlClient;
  /** Where a job with no project runs (DESIGN §13). */
  readonly workspace: string;
  /** The profile's scripts folder, where pre-run scripts are. */
  readonly scripts: string;
  /** The decision layer's injection answer about untrusted text. */
  readonly scan: (text: string) => Effect.Effect<DecisionAnswer | undefined>;
};

/** A run's occurrence: its job, its owning thread, when it was due, and its own thread. */
type Occurrence = { readonly jobId: JobId; readonly owner: ThreadId; readonly scheduledInstant: string; readonly runThreadId: ThreadId };

/**
 * How a scheduled job's runs start and end (DESIGN §15, ADR 0032). A claimed occurrence runs the job's pre-run script,
 * if it has one, then starts a thread of its own in the job's project, or the workspace, and Verdandi sends its turn
 * there. The run ends when its task stops: its last turn's status, the rejection of its turn, or what its script decided.
 * One a used-up subscription window held sends its turn again once released.
 */
export const makeScheduleRuns = ({ dispatch, sql, workspace, scripts, scan }: ScheduleRunsDeps) => {
  const report = (at: Omit<Occurrence, "runThreadId">, status: RunStatus, error?: string, output?: string) =>
    dispatch({
      type: "schedule.run.report",
      commandId: randomUUID() as CommandId,
      threadId: at.owner,
      jobId: at.jobId,
      scheduledInstant: at.scheduledInstant,
      status,
      ...(error !== undefined && { error }),
      ...(output !== undefined && { output }),
    }).pipe(Effect.asVoid);

  /** The turn `job` sends, after its script; or how the run ended before any turn (a missing folder, the script's say). */
  const prepare = (job: JobSpec) =>
    Effect.gen(function* () {
      const folder = job.project ?? workspace;
      if (!existsSync(folder)) {
        const missing: Extract<ScriptOutcome, { kind: "end" }> = {
          kind: "end",
          status: "blocked_config",
          error: `The job's folder ${folder} doesn't exist. Remove the job and add it again for a folder that does.`,
        };
        return missing;
      }
      if (job.script === undefined) return { kind: "send", text: job.text } as const;
      const script = yield* runScript(scripts, { ...job, script: job.script }, folder);
      if (script.kind === "end") return script;
      const answer = yield* scan(script.output);
      const flag = answer && flagged(answer) ? { text: script.output, answer } : undefined;
      return { kind: "send", text: withScriptOutput(job.text, job.script, script.output, answer), ...(flag && { flag }) } as const;
    });

  /** Sends `job`'s turn on the run's thread as Verdandi's; a refused turn is the run's result. */
  const send = (at: Occurrence, job: JobSpec, turn: { readonly text: string; readonly flag?: { text: string; answer: DecisionAnswer } }) =>
    Effect.gen(function* () {
      const turnId = randomUUID() as TurnId;
      yield* dispatch({
        type: "turn.send",
        commandId: randomUUID() as CommandId,
        threadId: at.runThreadId,
        turnId,
        text: turn.text,
        mode: job.mode,
      });
      if (turn.flag)
        yield* dispatch({
          type: "injection.flag",
          commandId: randomUUID() as CommandId,
          threadId: at.runThreadId,
          turnId,
          source: "script",
          ...turn.flag,
        }).pipe(Effect.catchCause((cause) => Effect.logWarning(`Could not record the injection flag on turn ${turnId}.`, cause)));
    }).pipe(
      Effect.catchTag("CommandRejected", (rejected) =>
        report(at, config.has(rejected.reason) ? "blocked_config" : "error", rejected.message),
      ),
    );

  /** Runs claimed occurrence `e`: its script, then its thread and turn. */
  const start = (e: Claimed) =>
    Effect.gen(function* () {
      const found = yield* loadJob(e.jobId);
      if (!found || found.state === "paused") return;
      const { job } = found;
      const at = { jobId: e.jobId, owner: e.threadId, scheduledInstant: e.scheduledInstant, runThreadId: e.runThreadId };
      const turn = yield* prepare(job);
      if (turn.kind === "end") return yield* report(at, turn.status, turn.error, turn.output);
      yield* dispatch({
        type: "schedule.run.start",
        commandId: randomUUID() as CommandId,
        threadId: e.runThreadId,
        jobId: e.jobId,
        name: job.name,
        ownerThreadId: e.threadId,
        scheduledInstant: e.scheduledInstant,
        projectPath: job.project ?? workspace,
        ...(job.route && { route: job.route }),
        ...(job.limits && { limits: job.limits }),
        worktree: job.worktree,
        ...(job.allowMetered && { allowMetered: true }),
      });
      yield* send(at, job, turn);
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchCause((cause) => Effect.logWarning(`Could not start the run of job ${e.jobId} due at ${e.scheduledInstant}.`, cause)),
    );

  /** Sends released occurrence `e`'s turn again, after its script runs again; held again if its window still is. */
  const resend = (e: Released) =>
    Effect.gen(function* () {
      const [run] = yield* sql<{ thread: ThreadId | null }>`select thread_id as thread from schedule_runs
        where job_id = ${e.jobId} and scheduled_instant = ${e.scheduledInstant}`;
      const found = yield* loadJob(e.jobId);
      if (!run?.thread || !found) return;
      const at = { jobId: e.jobId, owner: e.threadId, scheduledInstant: e.scheduledInstant, runThreadId: run.thread };
      const turn = yield* prepare(found.job);
      if (turn.kind === "end") return yield* report(at, turn.status, turn.error, turn.output);
      yield* send(at, found.job, turn);
    }).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.catchCause((cause) => Effect.logWarning(`Could not send the held run of job ${e.jobId} due at ${e.scheduledInstant}.`, cause)),
    );

  /** Lets every held occurrence try again: a harness reported a window that isn't used up. */
  const releaseHeld = Effect.gen(function* () {
    const held = yield* loadHeldRuns;
    yield* Effect.forEach(
      held,
      (r) =>
        dispatch({
          type: "schedule.release",
          commandId: randomUUID() as CommandId,
          threadId: r.owner,
          jobId: r.job_id,
          scheduledInstant: r.scheduled_instant,
        }),
      { discard: true },
    );
  }).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.catchCause((cause) => Effect.logWarning("Could not release the scheduled runs a used-up window held.", cause)),
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
      yield* report({ jobId: run.jobId, owner: run.ownerThreadId, scheduledInstant: run.scheduledInstant }, status, error);
    }).pipe(Effect.catchCause((cause) => Effect.logWarning(`Could not record how the scheduled run in thread ${threadId} ended.`, cause)));

  /**
   * Runs a stopped verdandid left unfinished: ended now, from their thread's last turn, or as never started. Never
   * started again: an occurrence runs at most once. Held ones stay held.
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
          : report(
              { jobId: r.job_id, owner: r.owner, scheduledInstant: r.scheduled_instant },
              "error",
              "verdandid stopped before this run started; it isn't run again.",
            ).pipe(
              Effect.catchCause((cause) => Effect.logWarning(`Could not end the run of job ${r.job_id} a stopped verdandid left.`, cause)),
            ),
      { discard: true },
    );
  });

  return { start, resend, releaseHeld, settle, recover };
};
