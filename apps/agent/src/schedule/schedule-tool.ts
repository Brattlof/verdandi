import { randomUUID } from "node:crypto";
import type { Command, CommandId, CommandRejected, JobId, Receipt, ThreadId } from "@verdandi/contracts";
import { type ScheduleServices, ToolFailed } from "@verdandi/tools";
import { Effect } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import { inRepo, sameFolder } from "../home/workspace.ts";
import { loadJobs } from "./schedule-store.ts";
import { localZone, parseWhen } from "./when.ts";

type Dispatch = (command: Command) => Effect.Effect<Receipt, CommandRejected | SqlError.SqlError>;

/** A refusal goes back to the agent as the tool's error; only a database failure is a defect. */
const refused = <A>(effect: Effect.Effect<A, ToolFailed | CommandRejected | SqlError.SqlError>) =>
  effect.pipe(
    Effect.catchTag("CommandRejected", (e) => Effect.fail(new ToolFailed({ message: e.message }))),
    Effect.catchTag("SqlError", Effect.die),
  );

/**
 * `cronjob`'s services (DESIGN §9.6, §15): a job the agent creates is owned by its thread and runs in that thread's
 * project, or the workspace, in a worktree when the project is a git repo; never with a route or limits of its own.
 */
export const makeScheduleTools = (dispatch: Dispatch, sql: SqlClient.SqlClient, workspace: string): ScheduleServices => ({
  create: (request, at) =>
    refused(
      Effect.gen(function* () {
        const [thread] = yield* sql<{ path: string }>`
          select p.path from threads t join projects p on p.id = t.project_id where t.id = ${at.threadId}`;
        const project = !thread || sameFolder(thread.path, workspace) ? null : thread.path;
        const jobId = randomUUID() as JobId;
        yield* dispatch({
          type: "schedule.create",
          commandId: randomUUID() as CommandId,
          threadId: at.threadId,
          jobId,
          job: {
            name: request.name,
            project,
            text: request.task,
            mode: request.mode,
            schedule: parseWhen(request.schedule, request.timezone ?? localZone(), new Date()),
            worktree: project !== null && inRepo(project),
            missed: "run",
          },
        });
        const [job] = yield* sql<{ next: string | null }>`select next_run_at as next from schedules where id = ${jobId}`;
        return job?.next ?? null;
      }),
    ),
  list: () => loadJobs(1).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
  pause: (name) =>
    refused(
      Effect.gen(function* () {
        const [job] = yield* sql<{ id: JobId; owner: ThreadId }>`
          select id, owner_thread_id as owner from schedules where name = ${name} and state != 'removed'`;
        if (!job) return yield* Effect.fail(new ToolFailed({ message: `No job is named ${name}. List them with action "list".` }));
        yield* dispatch({
          type: "schedule.pause",
          commandId: randomUUID() as CommandId,
          threadId: job.owner,
          jobId: job.id,
        });
      }),
    ),
});
