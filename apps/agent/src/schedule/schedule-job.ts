import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ScheduledJob, ScheduledRun } from "@verdandi/contracts";
import { Schema } from "effect";

const bin = join(import.meta.dir, "..", "bin.ts");

/** `verdandi run`'s arguments for one firing of `job`: unattended, so every request is denied and nothing approved. */
export const runArgs = (home: string, job: ScheduledJob) => [
  "run",
  "--home",
  home,
  "--project",
  job.folder,
  "--deny-requests",
  "--json",
  ...(job.worktree ? ["--worktree"] : []),
  ...(job.mode ? ["--mode", job.mode] : []),
  ...(job.route ? ["--route", job.route] : []),
  job.task,
];

/** What the log keeps of `verdandi run --json`'s object, or the tail of its stderr when it printed none (bad flags, no verdandid). */
const outcome = (at: string, exitCode: number, stdout: string, stderr: string): ScheduledRun => {
  try {
    const { threadId, status, cost, error } = JSON.parse(stdout.trimEnd().split(/\r?\n/).at(-1) ?? "");
    return Schema.decodeUnknownSync(ScheduledRun)({ v: 1, at, exitCode, threadId, status, cost, ...(error && { error }) });
  } catch {
    return { v: 1, at, exitCode, error: stderr.trimEnd().split(/\r?\n/).slice(-20).join("\n") || "verdandi run printed nothing." };
  }
};

/**
 * Runs the job saved in `file` (`<home>/schedules/<name>.json`) once with `verdandi run`, which connects to the
 * profile's verdandid or runs one for the run, and appends how it went to the job's log. A job's module calls this
 * when the OS scheduler fires it (`Bun.cron`).
 */
export const fire = async (file: string) => {
  const at = new Date().toISOString();
  let run: ScheduledRun;
  try {
    const job = Schema.decodeUnknownSync(ScheduledJob)(JSON.parse(readFileSync(file, "utf8")));
    if (job.envPath) process.env.PATH = job.envPath;
    const proc = Bun.spawn([process.execPath, bin, ...runArgs(dirname(dirname(file)), job)], {
      cwd: job.folder,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    run = outcome(at, exitCode, stdout, stderr);
  } catch (e) {
    run = { v: 1, at, exitCode: null, error: e instanceof Error ? e.message : String(e) };
  }
  appendFileSync(file.replace(/\.json$/, ".log"), `${JSON.stringify(run)}\n`);
};
