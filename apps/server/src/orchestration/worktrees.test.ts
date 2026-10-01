import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, ThreadId, TurnId } from "@verdandi/contracts";
import { git, makeFakeHarness, makeTempHome, makeTempRepo, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { AppLayer } from "./app.ts";
import { Engine } from "./engine.ts";
import { loadThreadView } from "./projector.ts";
import { Reactor } from "./reactor.ts";

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
/** A file's text with CRLF read as LF: a checkout on Windows may convert line endings (core.autocrlf). */
const text = (path: string) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
let n = 0;
const id = <T>() => `id-${++n}` as T;
const route = { harness: "fake", model: "fake", effort: "low" } as const;

test("two threads in one repo each edit the same file in their own worktree, and removing one keeps its branch", async () => {
  const repo = temp(makeTempRepo({ "a.txt": "one\n" }));
  mkdirSync(join(repo, ".verdandi"));
  writeFileSync(join(repo, ".verdandi", "worktree.yaml"), "setup: echo set up\n");
  const runtime = ManagedRuntime.make(AppLayer(temp(makeTempHome()), { fake: makeFakeHarness() }));
  runtimes.push(runtime as never);
  const dispatch = (c: Command) => runtime.runPromise(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  const rejected = (c: Command) => runtime.runPromise(Effect.flip(Effect.flatMap(Engine, (e) => e.dispatch(c))));
  const settle = () => runtime.runPromise(Effect.flatMap(Reactor, (r) => r.drain));
  const view = (threadId: ThreadId) => runtime.runPromise(loadThreadView(threadId));
  const send = (threadId: ThreadId, text: string): Command => ({
    type: "turn.send",
    commandId: id<CommandId>(),
    threadId,
    turnId: id<TurnId>(),
    text,
    mode: "build",
  });
  const [one, two] = [id<ThreadId>(), id<ThreadId>()];

  for (const threadId of [one, two]) {
    await dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId, projectPath: repo, route, worktree: true });
    // Sent at once: the turn waits for its worktree.
    await dispatch(send(threadId, "edit a.txt"));
  }
  await settle();
  const [first, second] = [await view(one), await view(two)];
  for (const v of [first, second]) {
    expect(v?.turns.map((t) => t.status)).toEqual(["success"]);
    expect(v?.worktree).toMatchObject({ state: "ready", setup: { command: "echo set up", passed: true } });
    expect(text(join(v?.worktree?.path ?? "", "a.txt"))).toBe("one\nedited by the fake harness\n");
  }
  expect(first?.worktree?.path).not.toBe(second?.worktree?.path);
  expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("one\n");

  // Uncommitted changes keep the worktree, until the user removes it anyway.
  await dispatch({ type: "thread.worktree.remove", commandId: id<CommandId>(), threadId: one, force: false });
  await settle();
  expect((await view(one))?.worktree).toMatchObject({ state: "ready", error: expect.stringContaining("uncommitted changes") });
  await dispatch({ type: "thread.worktree.remove", commandId: id<CommandId>(), threadId: one, force: true });
  await settle();
  const removed = await view(one);
  expect(removed?.worktree?.state).toBe("removed");
  expect(existsSync(first?.worktree?.root ?? "")).toBe(false);
  const branch = removed?.worktree?.branch ?? "";
  expect(git(repo, "branch", "--list", branch).trim()).toBe(branch);
  expect(text(join(second?.worktree?.path ?? "", "a.txt"))).toBe("one\nedited by the fake harness\n");
  expect((await rejected(send(one, "hi"))).reason).toBe("WorktreeUnavailable");

  // The way back: the same worktree on its kept branch, then turns again.
  await dispatch({ type: "thread.worktree.add", commandId: id<CommandId>(), threadId: one });
  await dispatch(send(one, "hi"));
  await settle();
  const back = await view(one);
  expect(back?.worktree).toMatchObject({ state: "ready", path: first?.worktree?.path });
  expect(back?.turns.at(-1)?.status).toBe("success");

  // Archiving removes the worktree too, but git keeps one with uncommitted changes, and the thread says so.
  await dispatch({ type: "thread.archive", commandId: id<CommandId>(), threadId: two });
  await settle();
  expect((await view(two))?.worktree).toMatchObject({ state: "ready", error: expect.stringContaining("uncommitted changes") });
});

test("a thread that ran in the project folder can't move into a worktree", async () => {
  const repo = temp(makeTempRepo({ "a.txt": "one\n" }));
  const runtime = ManagedRuntime.make(AppLayer(temp(makeTempHome()), { fake: makeFakeHarness() }));
  runtimes.push(runtime as never);
  const run = <A, E>(f: (e: Engine["Service"]) => Effect.Effect<A, E>) => runtime.runPromise(Effect.flatMap(Engine, f));
  const threadId = id<ThreadId>();
  await run((e) => e.dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId, projectPath: repo, route }));
  await run((e) =>
    e.dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId: id<TurnId>(), text: "hi", mode: "build" }),
  );
  const error = await run((e) => Effect.flip(e.dispatch({ type: "thread.worktree.add", commandId: id<CommandId>(), threadId })));
  expect(error.message).toContain("Start a new thread in a worktree");
});
