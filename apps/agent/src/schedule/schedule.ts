import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ScheduledJob, ScheduledRun } from "@verdandi/contracts";
import { Schema } from "effect";

/** Registers and removes OS-level jobs. `osRegistrar` is Bun's (crontab, launchd, Task Scheduler); tests pass a fake. */
export type Registrar = {
  readonly add: (module: string, cron: string, title: string) => Promise<void>;
  readonly remove: (title: string) => Promise<void>;
};
export const osRegistrar: Registrar = {
  add: (module, cron, title) => Bun.cron(module, cron, title),
  remove: (title) => Bun.cron.remove(title),
};

export const schedulesDir = (home: string) => join(home, "schedules");
/** A job's files: its arguments, the module the OS scheduler runs, and one line per run. */
const jobFiles = (home: string, name: string) => {
  const base = join(schedulesDir(home), name);
  return { job: `${base}.json`, module: `${base}.ts`, log: `${base}.log` };
};

/** The OS job's title, with a hash of the home so two profiles' jobs of the same name never collide. */
export const jobTitle = (home: string, name: string) =>
  `verdandi-${new Bun.CryptoHasher("sha256").update(resolve(home)).digest("hex").slice(0, 8)}-${name}`;

/** When `cron` fires next, in local time. Fails naming the syntax when it isn't an expression, or when it never fires. */
export const nextRun = (cron: string, from = Date.now()) => {
  let next: Date | null;
  try {
    next = Bun.cron.parse(cron, from);
  } catch (e) {
    throw new Error(
      `"${cron}" isn't a cron expression (${e instanceof Error ? e.message : String(e)}). Give five fields, minute hour day month weekday, e.g. "0 2 * * *" for 2:00 every night, or a nickname such as @daily.`,
    );
  }
  if (!next) throw new Error(`"${cron}" never fires (no date matches it in the next 8 years). Check its day and month.`);
  return next;
};

/** Bun's errors for the two failures with a fix the user can make, reworded to name it; any other passes through. */
const registrarError = (cron: string, e: unknown) => {
  const message = e instanceof Error ? e.message : String(e);
  if (/too many triggers/i.test(message))
    return new Error(
      `Windows Task Scheduler can't hold "${cron}": it needs more than the 48 triggers a task may have. Use a minute step that divides 60 (*/5, */10, */15, */20 or */30), or restrict fewer fields.`,
    );
  if (/Security Identifier \(SID\)/i.test(message))
    return new Error(
      "Task Scheduler couldn't resolve your Windows account's security identifier (SID), as happens under a service account. Run verdandi schedule add as a regular signed-in user.",
    );
  return new Error(`The OS scheduler refused the job: ${message}`);
};

/**
 * Saves `job` and registers it with the OS scheduler, which from then on runs its module on `job.cron`. Refuses a name
 * that's taken; a registration that fails leaves no files behind.
 */
export const addJob = async (home: string, job: ScheduledJob, registrar: Registrar) => {
  if (!Schema.is(ScheduledJob.fields.name)(job.name))
    throw new Error(`"${job.name}" can't name a job: use letters, digits, - and _, up to 64 of them, e.g. nightly-deps.`);
  const files = jobFiles(home, job.name);
  if (existsSync(files.job) || existsSync(files.module))
    throw new Error(`A job named ${job.name} exists already. Pick another name, or remove it first: verdandi schedule remove ${job.name}`);
  const next = nextRun(job.cron);
  mkdirSync(schedulesDir(home), { recursive: true });
  writeFileSync(files.job, `${JSON.stringify(job, null, 2)}\n`);
  writeFileSync(
    files.module,
    `// \`verdandi schedule add ${job.name}\` wrote this module, which the OS scheduler runs; \`verdandi schedule remove ${job.name}\` deletes it.\n` +
      `import { fire } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "schedule-job.ts")).href)};\n` +
      `export default { scheduled: () => fire(${JSON.stringify(files.job)}) };\n`,
  );
  try {
    await registrar.add(files.module, job.cron, jobTitle(home, job.name));
  } catch (e) {
    rmSync(files.job, { force: true });
    rmSync(files.module, { force: true });
    throw registrarError(job.cron, e);
  }
  return { module: files.module, next };
};

/** Unregisters the job named `name` and deletes its files, log included. */
export const removeJob = async (home: string, name: string, registrar: Registrar) => {
  const files = jobFiles(home, name);
  if (!existsSync(files.job) && !existsSync(files.module))
    throw new Error(`No job is named ${name}. List the jobs with: verdandi schedule list`);
  await registrar.remove(jobTitle(home, name));
  for (const file of Object.values(files)) rmSync(file, { force: true });
};

export type JobListing = {
  readonly name: string;
  readonly job?: ScheduledJob;
  readonly next?: Date;
  readonly last?: ScheduledRun;
  /** Why the job's file can't be read, in place of `job`. */
  readonly error?: string;
};

/** Every saved job by name, with its next run and its last run's result. */
export const listJobs = (home: string): JobListing[] => {
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
        return { name, job, next: nextRun(job.cron), ...(last && { last }) };
      } catch (e) {
        return { name, error: e instanceof Error ? e.message : String(e) };
      }
    });
};
