import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ScheduledJob } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, makeTempRepo, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { type ServerFile, serverFile } from "../home/home.ts";
import { ensureWorkspace } from "../home/workspace.ts";
import { ServerInfo, ServerLayer } from "../rpc/server.ts";
import { hasOsJob, jobTitle, listOsJobs, type Registrar, removeOsJob, schedulesDir } from "./schedule.ts";
import { osJobsText, parseJob } from "./schedule-cli.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const temp = (dir: string) => {
  cleanups.push(() => removeTempHome(dir));
  return dir;
};

/** Stands in for the OS scheduler: records what would be unregistered. */
const fakeRegistrar = () => {
  const removed: string[] = [];
  const registrar: Registrar = { remove: async (title) => void removed.push(title) };
  return { registrar, removed };
};

/** An OS scheduler entry as an earlier `verdandi schedule add` left it (#209): its job file and the module the OS runs. */
const writeOsJob = (home: string, job: ScheduledJob) => {
  mkdirSync(schedulesDir(home), { recursive: true });
  const file = join(schedulesDir(home), `${job.name}.json`);
  writeFileSync(file, JSON.stringify(job));
  const module = join(schedulesDir(home), `${job.name}.ts`);
  writeFileSync(
    module,
    `import { fire } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "schedule-job.ts")).href)};\n` +
      `export default { scheduled: () => fire(${JSON.stringify(file)}) };\n`,
  );
  return module;
};

test("an OS scheduler entry an earlier verdandi left still runs, is listed with its last run, and remove --os takes it out", async () => {
  const home = temp(makeTempHome());
  const project = temp(makeTempHome());
  const runtime = ManagedRuntime.make(ServerLayer(home, { fake: makeFakeHarness() }));
  cleanups.push(() => runtime.dispose());
  const info = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ServerInfo;
    }),
  );
  writeFileSync(serverFile(home), JSON.stringify({ ...info, pid: process.pid } satisfies ServerFile));
  const job = {
    v: 1,
    name: "nightly",
    cron: "0 2 * * *",
    task: "hello",
    folder: project,
    worktree: false,
    route: "fake/fake/low",
    createdAt: "",
  } as const;
  const module = writeOsJob(home, job);

  // What the OS scheduler does when the entry fires (`bun run --cron-title=… <module>`).
  const { default: worker } = await import(pathToFileURL(module).href);
  await worker.scheduled({ type: "scheduled", cron: job.cron, scheduledTime: Date.now() });
  const [listed] = listOsJobs(home);
  expect(listed?.last).toMatchObject({ exitCode: 0, status: "completed" });
  expect(osJobsText(listOsJobs(home))).toContain("remove <name> --os");
  expect(osJobsText(listOsJobs(home))).toMatch(/nightly {2}0 2 \* \* \* {2}"hello" .* last ran .*: completed/);

  const { registrar, removed } = fakeRegistrar();
  await removeOsJob(home, "nightly", registrar);
  expect(removed).toEqual([jobTitle(home, "nightly")]);
  expect(readdirSync(schedulesDir(home))).toEqual([]);
  expect(hasOsJob(home, "nightly")).toBe(false);
  expect(osJobsText(listOsJobs(home))).toBe("");
}, 30_000);

test("two profiles' OS entries of one name have different titles", () => {
  expect(jobTitle("/a/profiles/work", "nightly")).not.toBe(jobTitle("/a/profiles/personal", "nightly"));
});

test("schedule add takes a cron expression in a zone, a time, or a duration, and a route or the router's pick", () => {
  const home = temp(makeTempHome());
  const now = new Date("2026-10-05T06:00:00.000Z");
  const job = (...flags: string[]) => parseJob(home, ["nightly", "tidy", "up", ...flags], home, now).job;
  expect(job("--cron", "@daily", "--tz", "Europe/Stockholm")).toMatchObject({
    text: "tidy up",
    schedule: { kind: "cron", cron: "@daily", tz: "Europe/Stockholm" },
    mode: "build",
    missed: "run",
  });
  expect(job("--in", "2h").schedule).toEqual({ kind: "once", at: "2026-10-05T08:00:00.000Z" });
  expect(job("--at", "2026-10-06T07:00:00Z").schedule).toEqual({ kind: "once", at: "2026-10-06T07:00:00.000Z" });
  expect(job("--in", "2h").route).toBeUndefined();
  expect(job("--in", "2h", "--route", "claude-code/opus/medium", "--max-cost", "1.5").route).toEqual({
    harness: "claude-code",
    model: "opus",
    effort: "medium",
  });
  expect(job("--in", "2h", "--max-cost", "1.5", "--max-turns", "20", "--skip-missed")).toMatchObject({
    limits: { maxCost: 1.5, maxTurns: 20 },
    missed: "skip",
  });
  expect(job("--in", "2h", "--script", "check.ts", "--script-only", "--allow-metered", "--watchdog", "30")).toMatchObject({
    script: "check.ts",
    agent: false,
    allowMetered: true,
    watchdogMinutes: 30,
  });
  expect(job("--in", "2h")).not.toHaveProperty("allowMetered");
  expect(() => job("--in", "2h", "--script-only")).toThrow("name it with --script");
  expect(() => job("--in", "2h", "--cron", "@daily")).toThrow("one of --cron, --at or --in");
  expect(() => job("--in", "soon")).toThrow("--in takes a duration");
  expect(() => job("--in", "2h", "--max-turns", "1.5")).toThrow("--max-turns takes a whole number");
});

test("a job in a project's git repo runs in a worktree unless --no-worktree; one in the workspace names no project and never does", () => {
  const home = temp(makeTempHome());
  const repo = temp(makeTempRepo({ "a.txt": "one\n" }));
  const job = (...flags: string[]) => parseJob(home, ["j", "do it", "--cron", "@daily", ...flags], repo).job;
  expect(job().worktree).toBe(true);
  expect(job().project).toBe(realpathSync.native(repo));
  expect(job("--no-worktree").worktree).toBe(false);
  // The workspace is a git repo too.
  ensureWorkspace(home);
  expect(job("--workspace")).toMatchObject({ project: null, worktree: false });
  expect(() => job("--workspace", "--worktree")).toThrow("(it's the workspace)");
  expect(existsSync(schedulesDir(home))).toBe(false);
});
