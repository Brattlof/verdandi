import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, ThreadId, TurnId } from "@verdandi/contracts";
import { git, gitHeavyTimeout, makeFakeHarness, makeTempHome, makeTempRepo, removeTempHome } from "@verdandi/testkit";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { checkpointRef } from "../checkpoints/checkpoint.ts";
import { cleanup } from "../cli/doctor.ts";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { loadThreadView } from "../event-store/projector.ts";
import { Reactor } from "../event-store/reactor.ts";
import { Gc, GcLive } from "./gc.ts";

setDefaultTimeout(gitHeavyTimeout);

const dirs: string[] = [];
const runtimes: ManagedRuntime.ManagedRuntime<unknown, unknown>[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const d of dirs.splice(0)) removeTempHome(d);
});
const temp = (d: string) => {
  dirs.push(d);
  return d;
};
let n = 0;
const id = <T>() => `id-${++n}` as T;
const route = { harness: "fake", model: "fake", effort: "low" } as const;
const day = 24 * 60 * 60 * 1000;

const start = (home: string) => {
  const runtime = ManagedRuntime.make(GcLive(home).pipe(Layer.provideMerge(AppLayer(home, { fake: makeFakeHarness() }))));
  runtimes.push(runtime as never);
  return runtime;
};

test("a sweep removes old checkpoints and an archived thread's clean worktree, keeps a dirty one with a reason, and a dry run changes nothing", async () => {
  const repo = temp(makeTempRepo({ "a.txt": "one\n" }));
  const home = temp(makeTempHome());
  writeFileSync(join(home, "gc.yaml"), "keepDays: 30\nkeepTurns: 1\n");
  const runtime = start(home);
  const dispatch = (c: Command) => runtime.runPromise(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  const settle = () => runtime.runPromise(Effect.flatMap(Reactor, (r) => r.drain));
  const sweep = (dryRun: boolean, now: number) => runtime.runPromise(Effect.flatMap(Gc, (gc) => gc.run({ dryRun, now })));
  const send = async (threadId: ThreadId, text: string) => {
    const turnId = id<TurnId>();
    await dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId, text, mode: "build" });
    return turnId;
  };
  const refs = () => git(repo, "for-each-ref", "--format=%(refname)").trim().split(/\r?\n/).sort();
  const of = (threadId: ThreadId) => (ref: string) =>
    ref.startsWith(`refs/verdandi/checkpoints/${threadId}/`) || ref.startsWith(`refs/verdandi/reverts/${threadId}/`);

  // A thread in the project folder with three turns: only its last turn and its first checkpoint are kept.
  const active = id<ThreadId>();
  await dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId: active, projectPath: repo, route });
  const turns: TurnId[] = [];
  for (const text of ["one", "two", "three"]) {
    turns.push(await send(active, text));
    await settle();
  }
  // Two archived threads whose worktrees git kept for their uncommitted changes; one is cleaned up since.
  const [clean, dirty] = [id<ThreadId>(), id<ThreadId>()];
  for (const threadId of [clean, dirty]) {
    await dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId, projectPath: repo, route, worktree: true });
    await send(threadId, "edit a.txt");
    await settle();
    await dispatch({ type: "thread.archive", commandId: id<CommandId>(), threadId });
    await settle();
  }
  const view = (threadId: ThreadId) => runtime.runPromise(loadThreadView(threadId));
  const cleanRoot = (await view(clean))?.worktree?.root ?? "";
  const dirtyRoot = (await view(dirty))?.worktree?.root ?? "";
  git(cleanRoot, "checkout", "--", "a.txt");
  // Another profile's thread, and a ref outside Verdandi's: never ours to remove.
  git(repo, "update-ref", "refs/verdandi/checkpoints/other-profile/turn/start", "HEAD");
  git(repo, "update-ref", "refs/keep/me", "HEAD");
  // A running turn's thread is left alone.
  const busy = id<ThreadId>();
  await dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId: busy, projectPath: repo, route });
  const busyTurn = await send(busy, "one");
  await settle();
  const hanging = await send(busy, "hang");

  const later = Date.now() + 31 * day;
  // The running turn saves its start checkpoint whenever it gets to it.
  const before = refs().filter((r) => !of(busy)(r));
  const plan = await sweep(true, later);
  const doctor = await cleanup(home, later);
  expect(refs().filter((r) => !of(busy)(r))).toEqual(before);
  expect(existsSync(cleanRoot) && existsSync(dirtyRoot)).toBe(true);

  const report = await sweep(false, later);
  await dispatch({ type: "turn.interrupt", commandId: id<CommandId>(), threadId: busy, turnId: hanging });
  await settle();
  expect(plan.dryRun).toBe(true);
  expect([plan.removed, plan.worktrees]).toEqual([report.removed, report.worktrees]);
  const [t1, t2, t3] = turns as [TurnId, TurnId, TurnId];
  const removed = [checkpointRef(active, t1, "end"), checkpointRef(active, t2, "start"), checkpointRef(active, t2, "end")];
  expect(report.removed.find((r) => r.threadId === active)?.refs.toSorted()).toEqual(removed.toSorted());
  expect(report.removed.map((r) => r.threadId).toSorted()).toEqual([active, clean, dirty].toSorted());
  const left = refs();
  for (const ref of [checkpointRef(active, t1, "start"), checkpointRef(active, t3, "start"), checkpointRef(active, t3, "end")])
    expect(left).toContain(ref);
  for (const ref of removed) expect(left).not.toContain(ref);
  expect(left.filter((r) => of(clean)(r) || of(dirty)(r))).toEqual([]);
  expect(left).toContain(checkpointRef(busy, busyTurn, "end"));
  expect(left).toContain("refs/verdandi/checkpoints/other-profile/turn/start");
  expect(left).toContain("refs/keep/me");

  expect(report.worktrees).toEqual([
    { threadId: clean, root: cleanRoot },
    { threadId: dirty, root: dirtyRoot, kept: expect.stringContaining("uncommitted changes") },
  ]);
  expect((await view(clean))?.worktree?.state).toBe("removed");
  expect(existsSync(cleanRoot)).toBe(false);
  expect((await view(dirty))?.worktree?.state).toBe("ready");
  expect(existsSync(dirtyRoot)).toBe(true);
  const recorded = await runtime.runPromise(
    Effect.flatMap(
      SqlClient.SqlClient,
      (sql) => sql<{ thread_id: string }>`select thread_id from events where type = 'thread.checkpoints.removed'`,
    ),
  );
  expect(recorded.map((r) => r.thread_id).toSorted()).toEqual([active, clean, dirty].toSorted());

  expect(doctor.status).toBe("ok");
  expect(doctor.detail).toContain(`The next sweep removes ${removed.length + 4} of them`);
  expect(doctor.detail).toContain("1 worktree");
});

test("a broken gc.yaml stops the sweep, naming the file and the key", async () => {
  const home = temp(makeTempHome());
  writeFileSync(join(home, "gc.yaml"), "keepDays: soon\n");
  const runtime = start(home);
  const error = await runtime.runPromise(Effect.flip(Effect.flatMap(Gc, (gc) => gc.run({ dryRun: true, now: Date.now() }))));
  expect(error.message).toContain(join(home, "gc.yaml"));
  expect(error.message).toContain("keepDays");
  expect((await cleanup(home, Date.now())).status).toBe("fail");
});
