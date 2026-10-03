import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { makeFakeHarness, makeTempHome, makeTempRepo, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { type ServerFile, serverFile } from "../home/home.ts";
import { ensureWorkspace } from "../home/workspace.ts";
import { ServerInfo, ServerLayer } from "../rpc/server.ts";
import { addJob, jobTitle, listJobs, type Registrar, removeJob, schedulesDir } from "./schedule.ts";
import { jobsText, parseJob } from "./schedule-cli.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const temp = (dir: string) => {
  cleanups.push(() => removeTempHome(dir));
  return dir;
};

/** Stands in for the OS scheduler: records what would be registered, or fails like Bun does. */
const fakeRegistrar = (fail?: string) => {
  const added: { module: string; cron: string; title: string }[] = [];
  const removed: string[] = [];
  const registrar: Registrar = {
    add: async (module, cron, title) => {
      if (fail) throw new Error(fail);
      added.push({ module, cron, title });
    },
    remove: async (title) => {
      removed.push(title);
    },
  };
  return { registrar, added, removed };
};

test("a saved job's module runs verdandi run against verdandid, and its log keeps the exit code and thread", async () => {
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
  const { registrar, added, removed } = fakeRegistrar();

  const argv = ["nightly", "hello", "there", "--cron", "0 2 * * *", "--project", project, "--route", "fake/fake/low"];
  const job = parseJob(home, argv, project);
  const { module } = await addJob(home, job, registrar);
  expect(added).toEqual([{ module, cron: "0 2 * * *", title: jobTitle(home, "nightly") }]);
  expect(listJobs(home)[0]?.last).toBeUndefined();

  // What the OS scheduler does when the job fires (`bun run --cron-title=… <module>`).
  const { default: worker } = await import(pathToFileURL(module).href);
  await worker.scheduled({ type: "scheduled", cron: job.cron, scheduledTime: Date.now() });
  const [listed] = listJobs(home);
  expect(listed?.last).toMatchObject({ exitCode: 0, status: "completed" });
  const threadId = listed?.last?.threadId ?? "";
  expect(threadId).not.toBe("");
  expect(jobsText(listJobs(home))).toMatch(new RegExp(`completed \\(exit 0\\).* · verdandi chat --thread ${threadId}`));

  await removeJob(home, "nightly", registrar);
  expect(removed).toEqual([jobTitle(home, "nightly")]);
  expect(readdirSync(schedulesDir(home))).toEqual([]);
}, 30_000);

test("two profiles' jobs of one name get different OS titles", () => {
  expect(jobTitle("/a/profiles/work", "nightly")).not.toBe(jobTitle("/a/profiles/personal", "nightly"));
});

test("Task Scheduler's two refusals name the fix and leave no files; a bad expression registers nothing", async () => {
  const home = temp(makeTempHome());
  const job = parseJob(home, ["every7", "tidy up", "--cron", "*/7 * * * *", "--workspace"], home);
  // Bun's own messages, which it throws on Windows.
  const triggers = fakeRegistrar(
    "This cron expression requires too many triggers for Windows Task Scheduler (max 48). Simplify the expression or use fewer restricted fields.",
  );
  expect(addJob(home, job, triggers.registrar)).rejects.toThrow("Use a minute step that divides 60");
  const sid = fakeRegistrar("Failed to register cron job: your Windows account's Security Identifier (SID) could not be resolved.");
  expect(addJob(home, job, sid.registrar)).rejects.toThrow("Run verdandi schedule add as a regular signed-in user");
  expect(readdirSync(schedulesDir(home))).toEqual([]);

  const unused = fakeRegistrar();
  expect(addJob(home, { ...job, cron: "every night" }, unused.registrar)).rejects.toThrow('"every night" isn\'t a cron expression');
  expect(addJob(home, { ...job, cron: "0 0 30 2 *" }, unused.registrar)).rejects.toThrow("never fires");
  expect(unused.added).toEqual([]);
});

test("a job in a project's git repo runs in a worktree unless --no-worktree; one in the workspace never does", () => {
  const home = temp(makeTempHome());
  const repo = temp(makeTempRepo({ "a.txt": "one\n" }));
  const job = (...flags: string[]) => parseJob(home, ["j", "do it", "--cron", "@daily", ...flags], repo);
  expect(job().worktree).toBe(true);
  expect(job().folder).toBe(realpathSync.native(repo));
  expect(job("--no-worktree").worktree).toBe(false);
  // The workspace is a git repo too.
  ensureWorkspace(home);
  expect(job("--workspace").worktree).toBe(false);
  expect(() => job("--workspace", "--worktree")).toThrow("(it's the workspace)");
  expect(existsSync(schedulesDir(home))).toBe(false);
});
