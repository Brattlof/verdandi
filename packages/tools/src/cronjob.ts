import type { InteractionMode, JobView } from "@verdandi/contracts";
import { Effect } from "effect";
import { defineTool, type ToolAt, ToolFailed } from "./define.ts";

/** What the agent asks `cronjob` to create: no route, model, effort or limits (DESIGN §9.6). */
export type JobRequest = {
  readonly name: string;
  readonly task: string;
  readonly schedule: string;
  readonly timezone: string | undefined;
  readonly mode: InteractionMode;
};

/** What `cronjob` needs from verdandid's scheduler (DESIGN §15). */
export type ScheduleServices = {
  /** Creates the job, owned by the calling thread; returns its next run (ISO), or fails with why it was refused. */
  readonly create: (job: JobRequest, at: ToolAt) => Effect.Effect<string | null, ToolFailed>;
  readonly list: () => Effect.Effect<readonly JobView[]>;
  readonly pause: (name: string) => Effect.Effect<void, ToolFailed>;
};

const modes: readonly string[] = ["ask", "plan", "build"];

/** One job as the agent reads it: name, schedule, state, next run, the task, and how its last run went. */
const jobLine = ({ job, state, nextRunAt, runs }: JobView) => {
  const when = job.schedule.kind === "cron" ? `${job.schedule.cron} (${job.schedule.tz})` : `once at ${job.schedule.at}`;
  const last = runs[0];
  return `- ${job.name}: ${when}, ${state}${nextRunAt ? `, next ${nextRunAt}` : ""}${last ? `, last run ${last.status}` : ""}. Task: ${job.text}`;
};

/**
 * `cronjob` (DESIGN §9.6, §15): the agent sets up, lists or pauses jobs verdandid's scheduler runs. It asks the user
 * first. A job it creates runs in this thread's project (or the workspace) on the router's pick under the project's
 * policy, unattended: its requests are denied, and its runs can't create jobs.
 */
export const cronjobTool = (services: ScheduleServices) =>
  defineTool({
    name: "cronjob",
    description:
      'Schedule a task to run later or repeatedly, unattended, in this thread\'s project (or the workspace); list the scheduled jobs; or pause one. Turn plain language into a schedule first: a 5-field cron expression or nickname ("0 7 * * 1-5" for weekdays at 7, "@daily"), an ISO time for a one-off ("2026-10-05T07:00:00+02:00"), or "in 2h" / "in 30m" / "in 1d". Each run starts a thread of its own on the router\'s pick; nobody watches it, so whatever it asks is denied. Write the task so it needs no answers. The user approves each call.',
    params: {
      action: { type: "string", description: '"create" a job, "list" the jobs, or "pause" one.' },
      name: {
        type: "string",
        description: "The job's name, to create or pause it: letters, digits, - and _, e.g. nightly-deps.",
        optional: true,
      },
      task: { type: "string", description: "To create: what each run does, written as the user's message to the agent.", optional: true },
      schedule: { type: "string", description: "To create: a cron expression or nickname, an ISO time, or in <n>m|h|d.", optional: true },
      timezone: {
        type: "string",
        description: "To create: the IANA time zone a cron expression is read in, e.g. Europe/Stockholm. Default: this machine's.",
        optional: true,
      },
      mode: { type: "string", description: 'To create: "ask", "plan" or "build" (default).', optional: true },
    },
    ask: true,
    run: (args, at) => {
      if (args.action === "list")
        return Effect.map(services.list(), (jobs) =>
          jobs.length === 0 ? "No jobs are scheduled." : `Scheduled jobs:\n${jobs.map(jobLine).join("\n")}`,
        );
      if (!args.name) return Effect.fail(new ToolFailed({ message: "`name` is required to create or pause a job." }));
      const name = args.name;
      if (args.action === "pause") return Effect.as(services.pause(name), `Paused ${name}: it doesn't run until the user resumes it.`);
      if (args.action !== "create") return Effect.fail(new ToolFailed({ message: '`action` must be "create", "list" or "pause".' }));
      if (!args.task || !args.schedule)
        return Effect.fail(new ToolFailed({ message: "`task` and `schedule` are required to create a job." }));
      const mode = args.mode ?? "build";
      if (!modes.includes(mode)) return Effect.fail(new ToolFailed({ message: '`mode` must be "ask", "plan" or "build".' }));
      const job = { name, task: args.task, schedule: args.schedule, timezone: args.timezone, mode: mode as InteractionMode };
      return Effect.map(services.create(job, at), (next) =>
        next
          ? `Scheduled ${name}: its first run is at ${next}. Each run gets a thread of its own; the user sees them with verdandi schedule list.`
          : `Scheduled ${name}, but it never fires.`,
      );
    },
  });
