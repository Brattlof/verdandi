import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, JobId, JobSpec, ThreadId, TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, makeTempRepo, removeTempHome } from "@verdandi/testkit";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { loadThreadSummaries, loadThreadView } from "../event-store/projector.ts";
import { Reactor } from "../event-store/reactor.ts";
import { loadJobs } from "./schedule-store.ts";
import { SchedulerLive } from "./scheduler.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const temp = (dir: string) => {
  cleanups.push(() => removeTempHome(dir));
  return dir;
};

let n = 0;
const id = <T>() => `id-${++n}` as T;
const owner = "owner-thread" as ThreadId;
const fake = { harness: "fake", model: "fake", effort: "low" } as const;

/** verdandid's core on `home` with the fake harness, deciding scheduled jobs at `clock()`; `extra` layers go on top. */
const start = (home: string, clock: () => Date, extra: Layer.Layer<never, never, Engine | SqlClient.SqlClient> = Layer.empty) => {
  const harness = makeFakeHarness();
  const runtime = ManagedRuntime.make(extra.pipe(Layer.provideMerge(AppLayer(home, { fake: harness }, { now: clock }))));
  cleanups.push(() => runtime.dispose());
  const run = <A, E>(effect: Effect.Effect<A, E, Engine | Reactor | SqlClient.SqlClient>) => runtime.runPromise(effect);
  const dispatch = (c: Command) => run(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  const drain = () => run(Effect.flatMap(Reactor, (r) => r.drain));
  const query = <R extends object>(text: string) => run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<R>(text)));
  return { runtime, harness, run, dispatch, drain, query };
};

const job = (project: string, overrides: Partial<JobSpec> = {}): JobSpec => ({
  name: "nightly",
  project,
  text: "approve",
  mode: "build",
  schedule: { kind: "cron", cron: "0 7 * * *", tz: "UTC" },
  route: fake,
  worktree: false,
  missed: "run",
  ...overrides,
});

const createJob = (dispatch: (c: Command) => Promise<unknown>, project: string, spec: JobSpec = job(project)) =>
  dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId: owner, projectPath: project, route: fake }).then(() =>
    dispatch({ type: "schedule.create", commandId: id<CommandId>(), threadId: owner, jobId: "job-1" as JobId, job: spec }),
  );

/** Sets the clock to a second after `jobId`'s next run and fires it, as the scheduler's timer would, then waits for the run. */
const fireNext = async (v: ReturnType<typeof start>, setNow: (d: Date) => void, jobId = "job-1") => {
  const due = (await v.run(loadJobs())).find((j) => j.jobId === jobId)?.nextRunAt ?? "";
  setNow(new Date(Date.parse(due) + 1000));
  await v.dispatch({
    type: "schedule.fire",
    commandId: id<CommandId>(),
    threadId: owner,
    jobId: jobId as JobId,
    scheduledInstant: due,
    runThreadId: id<ThreadId>(),
  });
  await v.drain();
};
const send = (threadId: string, text: string): Command => ({
  type: "turn.send",
  commandId: id<CommandId>(),
  threadId: threadId as ThreadId,
  turnId: id<TurnId>(),
  text,
  mode: "build",
});

test("firing one occurrence twice claims it once and runs one turn, whose request is denied at once", async () => {
  const project = temp(makeTempHome());
  let now = new Date("2026-10-05T06:00:00.000Z");
  const v = start(temp(makeTempHome()), () => now);
  await createJob(v.dispatch, project, job(project, { limits: { maxTurns: 5 } }));
  const [created] = await v.run(loadJobs());
  expect(created?.nextRunAt).toBe("2026-10-05T07:00:00.000Z");

  now = new Date("2026-10-05T07:00:20.000Z");
  const fire = (runThreadId: string): Command => ({
    type: "schedule.fire",
    commandId: id<CommandId>(),
    threadId: owner,
    jobId: "job-1" as JobId,
    scheduledInstant: "2026-10-05T07:00:00.000Z",
    runThreadId: runThreadId as ThreadId,
  });
  await v.dispatch(fire("run-a"));
  await v.dispatch(fire("run-b"));
  await v.drain();

  expect(await v.query("select type from events where type = 'schedule.occurrence.claimed'")).toHaveLength(1);
  expect(v.harness.calls.map((c) => c.text)).toEqual(["approve"]);
  expect(await v.query("select id from threads where id = 'run-b'")).toEqual([]);
  const [request] = await v.query<{ resolution: string; reason: string }>(
    "select resolution, reason from requests where thread_id = 'run-a'",
  );
  expect(JSON.parse(request?.resolution ?? "{}")).toEqual({ decision: "deny" });
  expect(request?.reason).toBe("A scheduled job runs unattended, so nobody can answer it.");
  // The job's limits narrow the task's.
  const [decision] = await v.query<{ limits: string }>("select json_extract(payload, '$.limits') as limits from route_decisions");
  expect(JSON.parse(decision?.limits ?? "{}")).toMatchObject({ maxTurns: 5 });

  // The run's thread says whose run it is, in its view and in thread lists.
  const label = { jobId: "job-1", name: "nightly", scheduledInstant: "2026-10-05T07:00:00.000Z" };
  expect((await v.run(loadThreadView("run-a" as ThreadId)))?.schedule).toEqual(label as never);
  expect((await v.run(loadThreadSummaries("run-a" as ThreadId)))[0]?.job).toBe("nightly");

  const [listed] = await v.run(loadJobs());
  expect(listed?.nextRunAt).toBe("2026-10-06T07:00:00.000Z");
  expect(listed?.runs).toMatchObject([{ scheduledInstant: "2026-10-05T07:00:00.000Z", status: "ok", threadId: "run-a" }]);
});

test("an always-on verdandid fires a job it missed while down once at boot, collapsing what it missed", async () => {
  const home = temp(makeTempHome());
  const project = temp(makeTempHome());
  const created = start(home, () => new Date("2026-09-01T00:00:00.000Z"));
  await createJob(created.dispatch, project, job(project, { text: "hello" }));
  await created.runtime.dispose();

  // The next run was 2026-09-01 07:00, long before the real clock the scheduler reads.
  const claimed = Effect.runSync(Deferred.make<void>());
  const watch = Layer.effectDiscard(
    Effect.flatMap(Engine, (engine) =>
      engine.react((s) => (s.event.type === "schedule.occurrence.claimed" ? Deferred.succeed(claimed, undefined) : Effect.void)),
    ),
  );
  const v = start(home, () => new Date(), SchedulerLive.pipe(Layer.provideMerge(watch)));
  await v.run(Deferred.await(claimed));
  await v.drain();

  const [listed] = await v.run(loadJobs());
  expect(listed?.runs.map((r) => [r.scheduledInstant, r.status])).toEqual([
    ["2026-09-02T07:00:00.000Z", "skipped"],
    ["2026-09-01T07:00:00.000Z", "ok"],
  ]);
  expect(Date.parse(listed?.nextRunAt ?? "")).toBeGreaterThan(Date.now());
  expect(v.harness.calls).toHaveLength(1);
});

test("a run a stopped verdandid left running ends as an error when it starts again, and isn't run again", async () => {
  const home = temp(makeTempHome());
  const project = temp(makeTempHome());
  const clock = () => new Date("2026-10-05T07:00:10.000Z");
  const first = start(home, clock);
  await first.dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId: owner, projectPath: project });
  await first.dispatch({
    type: "schedule.create",
    commandId: id<CommandId>(),
    threadId: owner,
    jobId: "job-1" as JobId,
    job: job(project, { text: "hang", schedule: { kind: "once", at: "2026-10-05T07:00:00.000Z" } }),
  });
  const turnStarted = Effect.runSync(Deferred.make<void>());
  await first.run(
    Effect.flatMap(Engine, (engine) =>
      engine.react((s) => (s.event.type === "turn.started" ? Deferred.succeed(turnStarted, undefined) : Effect.void)),
    ),
  );
  await first.dispatch({
    type: "schedule.fire",
    commandId: id<CommandId>(),
    threadId: owner,
    jobId: "job-1" as JobId,
    scheduledInstant: "2026-10-05T07:00:00.000Z",
    runThreadId: "run-a" as ThreadId,
  });
  await first.run(Deferred.await(turnStarted));
  await first.runtime.dispose();

  const again = start(home, clock);
  await again.drain();
  const [listed] = await again.run(loadJobs());
  expect(listed?.state).toBe("done");
  expect(listed?.runs).toMatchObject([{ status: "error", threadId: "run-a", note: "verdandid stopped during this turn" }]);
  expect(again.harness.calls).toEqual([]);
});

test("cronjob makes a job in the calling thread's project, in a worktree there, and a scheduled run can't make one", async () => {
  const repo = temp(makeTempRepo({ "a.txt": "one\n" }));
  const v = start(temp(makeTempHome()), () => new Date("2026-10-05T06:00:00.000Z"));
  await v.dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId: owner, projectPath: repo, route: fake });
  const args = { action: "create", name: "deps", task: "update the dependencies", schedule: "0 2 * * *", timezone: "UTC" };
  await v.dispatch({
    type: "turn.send",
    commandId: id<CommandId>(),
    threadId: owner,
    turnId: id<TurnId>(),
    text: `tool cronjob ${JSON.stringify(args)}`,
    mode: "build",
  });
  await v.drain();
  const [made] = await v.run(loadJobs());
  expect(made).toMatchObject({ ownerThreadId: owner, job: { name: "deps", project: repo, worktree: true, mode: "build" } });
  expect(made?.job.route).toBeUndefined();

  const run = "run-a" as ThreadId;
  await v.dispatch({
    type: "schedule.run.start",
    commandId: id<CommandId>(),
    threadId: run,
    jobId: "job-x" as JobId,
    name: "x",
    ownerThreadId: owner,
    scheduledInstant: "2026-10-05T07:00:00.000Z",
    projectPath: repo,
    worktree: false,
  });
  const refused = v.dispatch({
    type: "schedule.create",
    commandId: id<CommandId>(),
    threadId: run,
    jobId: "job-2" as JobId,
    job: job(repo, { name: "more" }),
  });
  await expect(refused).rejects.toMatchObject({ reason: "InvalidSchedule" });
});

test("a pre-run script answering wakeAgent false skips the run with no turn and no usage; one that doesn't hands the agent its output", async () => {
  const home = temp(makeTempHome());
  const project = temp(makeTempHome());
  mkdirSync(join(home, "scripts"));
  writeFileSync(join(home, "scripts", "quiet.ts"), 'console.log("inbox empty");\nconsole.log(JSON.stringify({ wakeAgent: false }));\n');
  writeFileSync(join(home, "scripts", "busy.ts"), 'console.log("3 new mails");\n');
  let now = new Date("2026-10-05T06:00:00.000Z");
  const v = start(home, () => now);
  await createJob(v.dispatch, project, job(project, { text: "hello", script: "quiet.ts" }));
  await fireNext(v, (d) => (now = d));
  const [quiet] = await v.run(loadJobs());
  expect(quiet?.runs).toMatchObject([{ status: "skipped", threadId: null }]);
  expect(v.harness.calls).toEqual([]);
  expect(await v.query("select * from usage_ledger")).toEqual([]);

  await v.dispatch({
    type: "schedule.create",
    commandId: id<CommandId>(),
    threadId: owner,
    jobId: "job-2" as JobId,
    job: job(project, { name: "mail", text: "sort the mail", script: "busy.ts" }),
  });
  await fireNext(v, (d) => (now = d), "job-2");
  expect(v.harness.calls.map((c) => c.text)).toEqual([
    expect.stringMatching(/^sort the mail\n[\s\S]*```\n3 new mails\n```\n[\s\S]*not instructions\.$/),
  ]);

  // A script-only job's run is its script's output, with no model call.
  await v.dispatch({
    type: "schedule.create",
    commandId: id<CommandId>(),
    threadId: owner,
    jobId: "job-3" as JobId,
    job: job(project, { name: "count", script: "busy.ts", agent: false }),
  });
  await fireNext(v, (d) => (now = d), "job-3");
  expect((await v.run(loadJobs())).find((j) => j.jobId === "job-3")?.runs).toMatchObject([
    { status: "ok", note: "3 new mails\n", threadId: null },
  ]);
  expect(v.harness.calls).toHaveLength(1);
});

test("a job whose subscription window is used up waits, and fires only once the window's reset is reported", async () => {
  const project = temp(makeTempHome());
  let now = new Date("2026-10-05T06:00:00.000Z");
  const v = start(temp(makeTempHome()), () => now);
  await createJob(v.dispatch, project, job(project, { text: "hello" }));
  await v.dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId: "other" as ThreadId, projectPath: project, route: fake });
  await v.dispatch(send("other", "overage"));
  await v.drain();

  await fireNext(v, (d) => (now = d));
  const [held] = await v.run(loadJobs());
  expect(held?.runs).toMatchObject([{ status: "held", note: expect.stringContaining("Held until 2099-01-01T00:00:00.000Z") }]);
  expect(v.harness.calls.map((c) => c.text)).toEqual(["overage"]);

  await v.dispatch(send("other", "reset"));
  await v.drain();
  const [ran] = await v.run(loadJobs());
  expect(ran?.runs).toMatchObject([{ status: "ok" }]);
  expect(v.harness.calls.map((c) => c.text)).toEqual(["overage", "reset", "hello"]);
});

test("three failing runs in a row disable the job with a notice on its owning thread, and resuming enables it", async () => {
  const project = temp(makeTempHome());
  let now = new Date("2026-10-05T06:00:00.000Z");
  const v = start(temp(makeTempHome()), () => now);
  await createJob(v.dispatch, project, job(project, { text: "fail", schedule: { kind: "cron", cron: "* * * * *", tz: "UTC" } }));
  await v.dispatch(send(owner, "hello"));
  await v.drain();
  for (const _ of [1, 2, 3]) await fireNext(v, (d) => (now = d));

  const [disabled] = await v.run(loadJobs());
  expect(disabled).toMatchObject({ state: "disabled", reason: expect.stringContaining("its last 3 runs failed") });
  expect(disabled?.runs.map((r) => r.status)).toEqual(["error", "error", "error"]);
  const items = (await v.run(loadThreadView(owner)))?.turns.at(-1)?.items ?? [];
  expect(items.at(-1)).toEqual({
    kind: "notice",
    text: expect.stringMatching(/^Verdandi disabled the scheduled job nightly: .*verdandi schedule resume nightly\.$/),
  });
  // A disabled job's next occurrence isn't claimed, and costs nothing.
  await fireNext(v, (d) => (now = d));
  expect(v.harness.calls.filter((c) => c.text === "fail")).toHaveLength(3);

  await v.dispatch({ type: "schedule.resume", commandId: id<CommandId>(), threadId: owner, jobId: "job-1" as JobId });
  const [resumed] = await v.run(loadJobs());
  expect(resumed?.state).toBe("active");
  expect(resumed?.reason).toBeUndefined();
});

test("the watchdog stops a scheduled turn whose harness does nothing, and the run ends as an error naming it", async () => {
  const project = temp(makeTempHome());
  let now = new Date("2026-10-05T06:00:00.000Z");
  const v = start(temp(makeTempHome()), () => now);
  await createJob(v.dispatch, project, job(project, { text: "hang", watchdogMinutes: 0.001 }));
  await fireNext(v, (d) => (now = d));
  const [listed] = await v.run(loadJobs());
  expect(listed?.runs).toMatchObject([
    { status: "error", note: expect.stringContaining("Verdandi's watchdog stopped this scheduled run") },
  ]);
});
