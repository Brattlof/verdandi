import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, TaskOutcome, ThreadId, TurnId } from "@verdandi/contracts";
import { git, makeFakeHarness, makeTempHome, makeTempRepo, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { loadThreadView } from "../event-store/projector.ts";
import { Reactor } from "../event-store/reactor.ts";
import { checkpointRef } from "./checkpoint.ts";

const dirs: string[] = [];
const runtimes: ManagedRuntime.ManagedRuntime<unknown, unknown>[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const d of dirs.splice(0)) removeTempHome(d);
});
let n = 0;
const id = <T>() => `id-${++n}` as T;
const threadId = "thread-1" as ThreadId;
const revert = (toTurnId: TurnId): Command => ({ type: "thread.revert", commandId: id<CommandId>(), threadId, toTurnId, files: true });
const undo: () => Command = () => ({ type: "thread.revert.undo", commandId: id<CommandId>(), threadId });
// Line endings as git checks files out: a restore on Windows (core.autocrlf) writes CRLF, like a checkout would.
const lf = (text: string) => text.replaceAll("\r\n", "\n");

/** A thread pinned to the fake harness in a new repo holding `files`, and ways to drive it. */
const setup = async (files: Record<string, string>) => {
  const repo = makeTempRepo(files);
  const home = makeTempHome();
  dirs.push(repo, home);
  const fake = makeFakeHarness();
  const runtime = ManagedRuntime.make(AppLayer(home, { fake }));
  runtimes.push(runtime as never);
  const dispatch = (c: Command) => runtime.runPromise(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  const settle = () => runtime.runPromise(Effect.flatMap(Reactor, (r) => r.drain));
  await dispatch({
    type: "thread.create",
    commandId: id<CommandId>(),
    threadId,
    projectPath: repo,
    route: { harness: "fake", model: "fake", effort: "low" },
  });
  return {
    repo,
    fake,
    rejected: (c: Command) => runtime.runPromise(Effect.flip(Effect.flatMap(Engine, (e) => e.dispatch(c)))),
    /** Dispatches `c` and waits for what it set off, such as restoring files. */
    run: async (c: Command) => {
      await dispatch(c);
      await settle();
    },
    view: () => runtime.runPromise(loadThreadView(threadId)),
    outcome: () =>
      runtime.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ status: TaskOutcome["status"] }>`select status from task_outcomes`),
      ),
    send: async (text: string) => {
      const turnId = id<TurnId>();
      await dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId, text, mode: "build" });
      await settle();
      return turnId;
    },
    file: (name: string) => (existsSync(join(repo, name)) ? lf(readFileSync(join(repo, name), "utf8")) : undefined),
    /** `name` as turn `turnId` left it. */
    endOf: (turnId: TurnId, name: string) => lf(git(repo, "show", `${checkpointRef(threadId, turnId, "end")}:${name}`)),
  };
};

test("reverting conversation and files to turn 1 of 3 forks the next turn from there, and undoing it brings turn 3's files back", async () => {
  const { fake, rejected, run, view, outcome, send, file, endOf } = await setup({ "a.txt": "one\n" });
  const t1 = await send("edit a.txt");
  const t2 = await send("edit new.txt");
  const t3 = await send("edit a.txt");
  const third = { a: file("a.txt"), new: file("new.txt") };
  expect(third.new).toBe("edited by the fake harness\n");
  expect((await rejected(revert(t3))).reason).toBe("InvalidRevert"); // nothing after the latest turn

  await run(revert(t1));
  const reverted = await view();
  expect(reverted?.turns.map((t) => t.reverted)).toEqual([false, true, true]);
  expect(reverted?.revert).toEqual({ toTurnId: t1, files: true, undone: false });
  expect(file("a.txt")).toBe(endOf(t1, "a.txt"));
  expect(file("new.txt")).toBeUndefined();
  expect(await outcome()).toEqual([{ status: "reverted" }]);

  await run(undo());
  expect({ a: file("a.txt"), new: file("new.txt") }).toEqual(third);
  expect((await view())?.turns.map((t) => t.reverted)).toEqual([false, false, false]);
  expect(await outcome()).toEqual([{ status: "completed" }]);

  // Reverted again, the next turn forks the conversation after turn 1, dropping turn 2 onwards.
  await run(revert(t1));
  const t4 = await send("hi");
  const fork = fake.calls.at(-1)?.fork;
  expect(fork).toMatchObject({ atTurnId: t1, dropTurnIds: [t2, t3] });
  const after = await view();
  expect(after?.sessionId).toBe("fake-session-2");
  expect(fake.history.get("fake-session-2")?.map((t) => t.turnId)).toEqual([t1, t4]);
  expect(after?.revert).toBeNull();
  expect((await rejected(undo())).reason).toBe("InvalidRevert"); // a turn has run since
  await send("and then");
  expect(fake.calls.at(-1)).toMatchObject({ resumeSessionId: "fake-session-2", fork: undefined });
});

test("a revert with files puts back only what the later turns changed, and its Undo only what the revert restored", async () => {
  const { repo, run, send, file, endOf } = await setup({ "a.txt": "one\n", "mine.txt": "mine\n" });
  const t1 = await send("edit a.txt");
  await send("edit a.txt");
  await send("edit made.txt");
  // The user's own edits after the last turn: a file the agent changed too, one it didn't, and a new one.
  writeFileSync(join(repo, "a.txt"), "the agent's and mine\n");
  writeFileSync(join(repo, "mine.txt"), "edited by hand\n");
  writeFileSync(join(repo, "notes.txt"), "made by hand\n");

  await run(revert(t1));
  expect(file("a.txt")).toBe(endOf(t1, "a.txt"));
  expect(file("made.txt")).toBeUndefined();
  expect(file("mine.txt")).toBe("edited by hand\n");
  expect(file("notes.txt")).toBe("made by hand\n");

  // Edited again between the revert and its Undo, which leaves it as it is.
  writeFileSync(join(repo, "mine.txt"), "edited again\n");
  await run(undo());
  expect(file("a.txt")).toBe("the agent's and mine\n");
  expect(file("made.txt")).toBe("edited by the fake harness\n");
  expect(file("mine.txt")).toBe("edited again\n");
  expect(file("notes.txt")).toBe("made by hand\n");
});

test("a revert names the files the reverted turns changed outside the thread's folder, which it can't restore", async () => {
  const elsewhere = makeTempHome();
  dirs.push(elsewhere);
  const outside = join(elsewhere, "outside.txt");
  const { run, view, send } = await setup({ "a.txt": "one\n" });
  const t1 = await send("edit a.txt");
  await send(`edit ${outside}`);

  await run(revert(t1));
  expect((await view())?.revert).toEqual({ toTurnId: t1, files: true, undone: false, outside: [realpathSync.native(outside)] });
  expect(readFileSync(outside, "utf8")).toBe("edited by the fake harness\n");
});

test("a revert restores the whole folder when a reverted turn has no checkpoints, says so, and its Undo puts all of it back", async () => {
  const { repo, run, view, send, file, endOf } = await setup({ "a.txt": "one\n" });
  const t1 = await send("edit a.txt");
  const t2 = await send("edit a.txt");
  git(repo, "update-ref", "-d", checkpointRef(threadId, t2, "start")); // as when saving it failed
  writeFileSync(join(repo, "notes.txt"), "made by hand\n");

  await run(revert(t1));
  expect(file("a.txt")).toBe(endOf(t1, "a.txt"));
  expect(file("notes.txt")).toBeUndefined();
  expect((await view())?.revert).toEqual({ toTurnId: t1, files: true, undone: false, whole: true });

  await run(undo());
  expect(file("notes.txt")).toBe("made by hand\n");
});
