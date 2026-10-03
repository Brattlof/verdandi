import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describeCost, InteractionMode, type ScheduledJob } from "@verdandi/contracts";
import { Schema } from "effect";
import { parseBatchRoute } from "../batch/batch.ts";
import { localMinute } from "../cli/thread-list.ts";
import { flag, resolveHome } from "../home/home.ts";
import { defaultFolder, inRepo, isWorkspace } from "../home/workspace.ts";
import { expandHome } from "../projects/project.ts";
import { addJob, type JobListing, listJobs, osRegistrar, type Registrar, removeJob } from "./schedule.ts";

const valueFlags = ["--home", "--cron", "--project", "--route", "--mode"];
const switches = ["--here", "--workspace", "--worktree", "--no-worktree"];

/**
 * `schedule add`'s job from its flags. Its folder is fixed now, since the OS scheduler starts the job anywhere:
 * `--project`, else the folder `verdandi run` would pick here. In a project's git repo each run gets a worktree of its
 * own unless `--no-worktree`; in the workspace never (DESIGN §15).
 */
export const parseJob = (home: string, argv: readonly string[], cwd: string): ScheduledJob => {
  const unknown = argv.find((a) => a.startsWith("--") && !valueFlags.includes(a.split("=")[0] ?? "") && !switches.includes(a));
  if (unknown) throw new Error(`verdandi schedule add has no ${unknown} flag.`);
  const [name, ...words] = argv.filter((a, i) => !a.startsWith("--") && !valueFlags.includes(argv[i - 1] ?? ""));
  const task = words.join(" ").trim();
  const cron = flag(argv, "--cron");
  if (!name || !task || !cron)
    throw new Error(
      'verdandi schedule add needs a name, a task and --cron, e.g. verdandi schedule add nightly "update the dependencies" --cron "0 2 * * *"',
    );
  const mode = flag(argv, "--mode");
  if (mode !== undefined && !Schema.is(InteractionMode)(mode)) throw new Error(`--mode takes ask, plan or build; not "${mode}".`);
  const route = flag(argv, "--route");
  if (route !== undefined) parseBatchRoute(route);
  const project = flag(argv, "--project");
  const named = [project !== undefined && "--project", argv.includes("--here") && "--here", argv.includes("--workspace") && "--workspace"];
  if (named.filter(Boolean).length > 1) throw new Error(`Pick one of ${named.filter(Boolean).join(" and ")}.`);
  const path = project === undefined ? defaultFolder(home, cwd, argv) : resolve(expandHome(project));
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${path} isn't a folder that exists. Check the spelling.`);
  const folder = realpathSync.native(path);
  if (argv.includes("--worktree") && argv.includes("--no-worktree")) throw new Error("Pick one of --worktree and --no-worktree.");
  const repo = !isWorkspace(home, folder) && inRepo(folder);
  if (argv.includes("--worktree") && !repo)
    throw new Error(
      `--worktree needs a project in a git repo, and ${folder} isn't one${isWorkspace(home, folder) ? " (it's the workspace)" : ""}.`,
    );
  return {
    v: 1,
    name,
    cron,
    task,
    folder,
    worktree: repo && !argv.includes("--no-worktree"),
    ...(mode && { mode }),
    ...(route && { route }),
    ...(process.env.PATH && { envPath: process.env.PATH }),
    createdAt: new Date().toISOString(),
  };
};

/** `schedule list`'s text: each job, when it runs next, and how its last run went. */
export const jobsText = (jobs: readonly JobListing[]) => {
  if (jobs.length === 0) return 'No scheduled jobs. Add one with: verdandi schedule add <name> "<task>" --cron "<expression>"\n';
  return jobs
    .map(({ name, job, next, last, error }) => {
      if (!job) return `${name}  can't be read (${error}). Remove it with: verdandi schedule remove ${name}\n`;
      const how = [job.worktree && "in a worktree", job.mode && `in ${job.mode} mode`, job.route && `on ${job.route}`].filter(Boolean);
      const where = `  "${job.task}" in ${job.folder}${how.length ? `, ${how.join(", ")}` : ""}\n`;
      const cost = last?.cost && describeCost(last.cost);
      const result = !last
        ? "  hasn't run yet\n"
        : `  last ran ${localMinute(last.at)}: ${last.status ?? "didn't run"} (exit ${last.exitCode ?? "none"})${cost ? ` · ${cost}` : ""}` +
          `${last.threadId ? ` · verdandi chat --thread ${last.threadId}` : ""}\n${last.error ? `  ${last.error.replace(/\n/g, "\n  ")}\n` : ""}`;
      return `${name}  ${job.cron}${next ? `  next ${localMinute(next.toISOString())}` : ""}\n${where}${result}`;
    })
    .join("\n");
};

/**
 * `verdandi schedule add|list|remove`: jobs the OS scheduler runs (crontab, launchd or Task Scheduler, through
 * `Bun.cron`), each calling `verdandi run --deny-requests --json` until the in-process scheduler (DESIGN §15) exists.
 */
export const schedule = async (argv: readonly string[], registrar: Registrar = osRegistrar) => {
  const [sub, ...rest] = argv;
  const home = resolveHome(argv);
  if (sub === "add") {
    const job = parseJob(home, rest, process.cwd());
    const { next } = await addJob(home, job, registrar);
    process.stdout.write(
      `Scheduled ${job.name}: "${job.task}" in ${job.folder}${job.worktree ? ", in a worktree of its own each run" : ""}, on ${job.cron}; next at ${localMinute(next.toISOString())}.\n` +
        "Each run denies whatever the agent asks; spend caps and task limits apply. See how runs went with: verdandi schedule list\n",
    );
    return;
  }
  if (sub === "list") {
    process.stdout.write(jobsText(listJobs(home)));
    return;
  }
  const name = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--home");
  if (sub === "remove" && name) {
    await removeJob(home, name, registrar);
    process.stdout.write(`Removed ${name}: the OS scheduler won't run it again, and its log is deleted.\n`);
    return;
  }
  throw new Error('Usage: verdandi schedule add <name> "<task>" --cron "<expression>" [flags] | list | remove <name>');
};
