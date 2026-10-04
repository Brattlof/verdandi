import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type CommandId, describeCost, InteractionMode, type JobId, type JobSpec, type JobView, type ThreadId } from "@verdandi/contracts";
import { Effect, Schema } from "effect";
import { parseBatchRoute } from "../batch/batch.ts";
import { localMinute } from "../cli/thread-list.ts";
import { flag, resolveHome, runningServer } from "../home/home.ts";
import { cliThreadsFile, defaultFolder, inRepo, isWorkspace, readCliThreads } from "../home/workspace.ts";
import { serverFor } from "../main.ts";
import { expandHome } from "../projects/project.ts";
import { connect } from "../rpc/client.ts";
import { listOsJobs, type OsJobListing, osRegistrar, type Registrar, removeOsJob } from "./schedule.ts";
import { describeWhen, localZone, parseWhen } from "./when.ts";

const valueFlags = ["--home", "--cron", "--tz", "--at", "--in", "--project", "--route", "--mode", "--max-cost", "--max-turns"];
const switches = ["--here", "--workspace", "--worktree", "--no-worktree", "--skip-missed", "--os", "--dev-fake-harness"];

const usage =
  'Usage: verdandi schedule add <name> "<task>" (--cron <expression> [--tz <zone>] | --at <time> | --in <duration>) [flags] | list | runs <name> | pause <name> | resume <name> | remove <name> [--os]';

/** A positive number from `--name`, or undefined when it's absent. */
const positive = (argv: readonly string[], name: string, integer: boolean) => {
  const value = flag(argv, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!(n > 0) || (integer && !Number.isInteger(n)))
    throw new Error(`${name} takes a ${integer ? "whole " : ""}number above 0; not "${value}".`);
  return n;
};

/**
 * `schedule add`'s job from its flags, and the folder it runs in: `--project`, else the folder `verdandi` would pick
 * here (the current project, or the workspace). In a project's git repo each run gets a worktree of its own unless
 * `--no-worktree`; in the workspace never (DESIGN §15).
 */
export const parseJob = (home: string, argv: readonly string[], cwd: string, now = new Date()): { job: JobSpec; folder: string } => {
  const unknown = argv.find((a) => a.startsWith("--") && !valueFlags.includes(a.split("=")[0] ?? "") && !switches.includes(a));
  if (unknown) throw new Error(`verdandi schedule add has no ${unknown} flag.`);
  const [name, ...words] = argv.filter((a, i) => !a.startsWith("--") && !valueFlags.includes(argv[i - 1] ?? ""));
  const text = words.join(" ").trim();
  const [cron, at, inside] = [flag(argv, "--cron"), flag(argv, "--at"), flag(argv, "--in")];
  const whens = [cron, at, inside].filter((w) => w !== undefined).length;
  if (!name || !text || whens !== 1)
    throw new Error(
      'verdandi schedule add needs a name, a task and one of --cron, --at or --in, e.g. verdandi schedule add nightly "update the dependencies" --cron "0 2 * * *"',
    );
  const tz = flag(argv, "--tz") ?? localZone();
  const schedule = cron !== undefined ? ({ kind: "cron", cron, tz } as const) : parseWhen(at !== undefined ? at : `in ${inside}`, tz, now);
  if (schedule.kind === "cron" && cron === undefined)
    throw new Error(
      at !== undefined
        ? `--at takes a time, e.g. 2026-10-05T07:00; not "${at}".`
        : `--in takes a duration, e.g. 2h, 30m or 1d; not "${inside}".`,
    );
  const mode = flag(argv, "--mode") ?? "build";
  if (!Schema.is(InteractionMode)(mode)) throw new Error(`--mode takes ask, plan or build; not "${mode}".`);
  const route = parseBatchRoute(flag(argv, "--route") ?? "auto");
  const maxCost = positive(argv, "--max-cost", false);
  const maxTurns = positive(argv, "--max-turns", true);
  const project = flag(argv, "--project");
  const named = [project !== undefined && "--project", argv.includes("--here") && "--here", argv.includes("--workspace") && "--workspace"];
  if (named.filter(Boolean).length > 1) throw new Error(`Pick one of ${named.filter(Boolean).join(" and ")}.`);
  const path = project === undefined ? defaultFolder(home, cwd, argv) : resolve(expandHome(project));
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${path} isn't a folder that exists. Check the spelling.`);
  const folder = realpathSync.native(path);
  if (argv.includes("--worktree") && argv.includes("--no-worktree")) throw new Error("Pick one of --worktree and --no-worktree.");
  const workspace = isWorkspace(home, folder);
  const repo = !workspace && inRepo(folder);
  if (argv.includes("--worktree") && !repo)
    throw new Error(`--worktree needs a project in a git repo, and ${folder} isn't one${workspace ? " (it's the workspace)" : ""}.`);
  return {
    folder,
    job: {
      name,
      project: workspace ? null : folder,
      text,
      mode,
      schedule,
      ...(route !== "auto" && { route }),
      ...((maxCost || maxTurns) && { limits: { ...(maxCost && { maxCost }), ...(maxTurns && { maxTurns }) } }),
      worktree: repo && !argv.includes("--no-worktree"),
      missed: argv.includes("--skip-missed") ? "skip" : "run",
    },
  };
};

/** Where and how a job runs, in one line. */
const howLine = (job: JobSpec) => {
  const route = job.route ? `on ${job.route.harness}/${job.route.model}/${job.route.effort}` : "on the router's pick";
  const limits = [job.limits?.maxCost && `$${job.limits.maxCost}`, job.limits?.maxTurns && `${job.limits.maxTurns} model calls`].filter(
    Boolean,
  );
  const how = [
    job.worktree && "in a worktree",
    job.mode !== "build" && `in ${job.mode} mode`,
    route,
    limits.length && `at most ${limits.join(" and ")}`,
  ];
  return `"${job.text}" in ${job.project ?? "the workspace"}, ${how.filter(Boolean).join(", ")}${job.missed === "skip" ? "; skips missed runs" : ""}`;
};

/** One occurrence: when it was due, how it went, and its thread or why it was skipped. */
const runLine = (r: JobView["runs"][number]) =>
  `${localMinute(r.scheduledInstant)}  ${r.status}${r.threadId ? `  verdandi chat --thread ${r.threadId}` : ""}${r.note ? `  (${r.note})` : ""}`;

/** `schedule list`'s text: each job, when it runs next, and how its last run went. */
export const jobsText = (jobs: readonly JobView[]) =>
  jobs.length === 0
    ? 'No scheduled jobs. Add one with: verdandi schedule add <name> "<task>" --cron "<expression>"\n'
    : jobs
        .map((j) => {
          const state = j.state === "active" && j.nextRunAt ? `next ${localMinute(j.nextRunAt)}` : j.state;
          const last = j.runs[0];
          return `${j.job.name}  ${describeWhen(j.job.schedule)}  ${state}\n  ${howLine(j.job)}\n  ${last ? `last: ${runLine(last)}` : "hasn't run yet"}\n`;
        })
        .join("\n");

/** The OS scheduler's entries from before verdandid's scheduler, which still run until removed. */
export const osJobsText = (jobs: readonly OsJobListing[]) =>
  jobs.length === 0
    ? ""
    : `\nLeft in the OS scheduler by an earlier verdandi schedule add (they still run; take each out with verdandi schedule remove <name> --os):\n${jobs
        .map(({ name, job, last, error }) => {
          if (!job) return `${name}  can't be read (${error})\n`;
          const cost = last?.cost && describeCost(last.cost);
          const result = last
            ? `last ran ${localMinute(last.at)}: ${last.status ?? "didn't run"}${cost ? ` · ${cost}` : ""}`
            : "hasn't run yet";
          return `${name}  ${job.cron}  "${job.task}" in ${job.folder}  ${result}\n`;
        })
        .join("")}`;

type Client = Effect.Success<ReturnType<typeof connect>>;

const findJob = (jobs: readonly JobView[], name: string) => {
  const job = jobs.find((j) => j.job.name === name);
  if (!job) throw new Error(`No job is named ${name}. List the jobs with: verdandi schedule list`);
  return job;
};

/**
 * Adds `job` on the CLI's thread for `folder`, the one `verdandi` opens there, which owns it: its runs end and
 * skips show there. A folder without one gets it now.
 */
const add = (client: Client, home: string, folder: string, job: JobSpec) =>
  Effect.gen(function* () {
    const threads = readCliThreads(home);
    const create = (threadId: ThreadId) =>
      client.CommandDispatch({
        type: "schedule.create",
        commandId: crypto.randomUUID() as CommandId,
        threadId,
        jobId: crypto.randomUUID() as JobId,
        job,
      });
    const known = threads[folder] as ThreadId | undefined;
    const made = known
      ? yield* create(known).pipe(
          Effect.as(true),
          // The thread the CLI remembered is gone (a new database): the job gets a new one.
          Effect.catchTag("CommandRejected", (e) => (e.reason === "ThreadNotFound" ? Effect.succeed(false) : Effect.fail(e))),
        )
      : false;
    if (made) return;
    const threadId = crypto.randomUUID() as ThreadId;
    yield* client.CommandDispatch({ type: "thread.create", commandId: crypto.randomUUID() as CommandId, threadId, projectPath: folder });
    writeFileSync(cliThreadsFile(home), JSON.stringify({ ...threads, [folder]: threadId }, null, 2));
    yield* create(threadId);
  });

/**
 * `verdandi schedule`: verdandid's scheduled jobs (DESIGN §15), which only an always-on verdandid (`verdandi start`)
 * runs, through the running verdandid or one run for the command; and the OS scheduler's entries an earlier verdandi
 * left (#209), listed so they can be removed.
 */
export const schedule = async (argv: readonly string[], registrar: Registrar = osRegistrar) => {
  const [sub, ...rest] = argv;
  const home = resolveHome(argv);
  const name = rest.find((a, i) => !a.startsWith("--") && !valueFlags.includes(rest[i - 1] ?? ""));
  if (sub === "remove" && name && argv.includes("--os")) {
    await removeOsJob(home, name, registrar);
    process.stdout.write(`Removed ${name} from the OS scheduler, with its files and log.\n`);
    return;
  }
  const parsed = sub === "add" ? parseJob(home, rest, process.cwd()) : undefined;
  if (!parsed && !(sub === "list" || (name && ["runs", "pause", "resume", "remove"].includes(sub ?? "")))) throw new Error(usage);
  const served = await serverFor(home, argv);
  const said = (text: string) => Effect.succeed(text);
  const action = (client: Client): Effect.Effect<string, unknown> =>
    Effect.gen(function* () {
      if (parsed) {
        yield* add(client, home, parsed.folder, parsed.job);
        const [job] = (yield* client.SchedulesList()).filter((j) => j.job.name === parsed.job.name);
        const next = job?.nextRunAt ? `; next at ${localMinute(job.nextRunAt)}` : "";
        const waits = runningServer(home)?.alwaysOn
          ? ""
          : "Only verdandi start runs scheduled jobs, and it isn't running: the job waits for it. What the job misses meanwhile runs once, late, when it starts, unless it skips missed runs; a one-off more than 2 minutes late never runs.\n";
        return `Scheduled ${parsed.job.name}: ${howLine(parsed.job)}, ${describeWhen(parsed.job.schedule)}${next}.\nEach run denies whatever the agent asks; spend caps and task limits apply. See its runs with: verdandi schedule runs ${parsed.job.name}\n${waits}`;
      }
      const jobs = yield* client.SchedulesList();
      if (sub === "list") return jobsText(jobs) + osJobsText(listOsJobs(home));
      const job = findJob(jobs, name ?? "");
      if (sub === "runs") return job.runs.length ? `${job.runs.map(runLine).join("\n")}\n` : `${job.job.name} hasn't run yet.\n`;
      const type = sub === "pause" ? "schedule.pause" : sub === "resume" ? "schedule.resume" : "schedule.remove";
      yield* client.CommandDispatch({ type, commandId: crypto.randomUUID() as CommandId, threadId: job.ownerThreadId, jobId: job.jobId });
      return {
        "schedule.pause": `Paused ${job.job.name}: it doesn't run until verdandi schedule resume ${job.job.name}.\n`,
        "schedule.resume": `Resumed ${job.job.name}: it runs from its next time on; what it missed while paused doesn't run.\n`,
        "schedule.remove": `Removed ${job.job.name}; its runs' threads stay.\n`,
      }[type];
    }).pipe(Effect.catchTag("CommandRejected", (e) => said(`${e.message}\n`)));
  try {
    process.stdout.write(await Effect.runPromise(Effect.scoped(Effect.flatMap(connect(served.server), action))));
  } finally {
    await served.stop?.();
  }
};
