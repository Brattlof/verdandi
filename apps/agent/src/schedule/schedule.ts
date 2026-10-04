import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ScheduledJob, ScheduledRun } from "@verdandi/contracts";
import { Schema } from "effect";

/**
 * Entries `verdandi schedule add` registered with the OS scheduler before verdandid had its own (#209): each a job file,
 * the module the OS scheduler runs (`schedule-job.ts`'s `fire`) and a log. They keep running until removed, so
 * `verdandi schedule list` shows them and `remove --os` takes them out.
 */

/** Removes OS-level jobs. `osRegistrar` is Bun's (crontab, launchd, Task Scheduler); tests pass a fake. */
export type Registrar = { readonly remove: (title: string) => Promise<void> };
export const osRegistrar: Registrar = { remove: (title) => Bun.cron.remove(title) };

export const schedulesDir = (home: string) => join(home, "schedules");
/** A job's files: its arguments, the module the OS scheduler runs, and one line per run. */
const jobFiles = (home: string, name: string) => {
  const base = join(schedulesDir(home), name);
  return { job: `${base}.json`, module: `${base}.ts`, log: `${base}.log` };
};

/** The OS job's title, with a hash of the home so two profiles' jobs of the same name never collide. */
export const jobTitle = (home: string, name: string) =>
  `verdandi-${new Bun.CryptoHasher("sha256").update(resolve(home)).digest("hex").slice(0, 8)}-${name}`;

/** Whether an OS scheduler entry named `name` has files in the home. */
export const hasOsJob = (home: string, name: string) => {
  const files = jobFiles(home, name);
  return existsSync(files.job) || existsSync(files.module);
};

/** Unregisters the OS entry named `name` and deletes its files, log included. */
export const removeOsJob = async (home: string, name: string, registrar: Registrar) => {
  if (!hasOsJob(home, name))
    throw new Error(`No OS scheduler entry is named ${name}. verdandi schedule list shows them, under their own heading.`);
  await registrar.remove(jobTitle(home, name));
  for (const file of Object.values(jobFiles(home, name))) rmSync(file, { force: true });
};

export type OsJobListing = {
  readonly name: string;
  readonly job?: ScheduledJob;
  readonly last?: ScheduledRun;
  /** Why the job's file can't be read, in place of `job`. */
  readonly error?: string;
};

/** Every OS scheduler entry by name, with its last run's result. */
export const listOsJobs = (home: string): OsJobListing[] => {
  const dir = schedulesDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const name = f.slice(0, -".json".length);
      const files = jobFiles(home, name);
      try {
        const job = Schema.decodeUnknownSync(ScheduledJob)(JSON.parse(readFileSync(files.job, "utf8")));
        const lines = existsSync(files.log) ? readFileSync(files.log, "utf8").trimEnd().split("\n") : [];
        const last = lines.at(-1) ? Schema.decodeUnknownSync(ScheduledRun)(JSON.parse(lines.at(-1) ?? "")) : undefined;
        return { name, job, ...(last && { last }) };
      } catch (e) {
        return { name, error: e instanceof Error ? e.message : String(e) };
      }
    });
};
