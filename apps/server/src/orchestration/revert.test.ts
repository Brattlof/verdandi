import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, TaskOutcome, ThreadId, TurnId } from "@verdandi/contracts";
import { git, makeFakeHarness, makeTempHome, makeTempRepo, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { checkpointRef } from "../workspace/checkpoint.ts";
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
let n = 0;
const id = <T>() => `id-${++n}` as T;
const threadId = "thread-1" as ThreadId;

test("reverting conversation and files to turn 1 of 3 forks the next turn from there, and undoing it brings turn 3's files back", async () => {
  const repo = makeTempRepo({ "a.txt": "one\n" });
  const home = makeTempHome();
  dirs.push(repo, home);
  const fake = makeFakeHarness();
  const runtime = ManagedRuntime.make(AppLayer(home, { fake }));
  runtimes.push(runtime as never);
  const dispatch = (c: Command) => runtime.runPromise(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  const rejected = (c: Command) => runtime.runPromise(Effect.flip(Effect.flatMap(Engine, (e) => e.dispatch(c))));
  const settle = () => runtime.runPromise(Effect.flatMap(Reactor, (r) => r.drain));
  const view = () => runtime.runPromise(loadThreadView(threadId));
  const outcome = () =>
    runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ status: TaskOutcome["status"] }>`select status from task_outcomes`),
    );
  const send = async (text: string) => {
    const turnId = id<TurnId>();
    await dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId, text, mode: "build" });
    await settle();
    return turnId;
  };
  const revert = (toTurnId: TurnId): Command => ({ type: "thread.revert", commandId: id<CommandId>(), threadId, toTurnId, files: true });
  const undo: () => Command = () => ({ type: "thread.revert.undo", commandId: id<CommandId>(), threadId });
  // Line endings as git checks files out: a restore on Windows (core.autocrlf) writes CRLF, like a checkout would.
  const lf = (text: string) => text.replaceAll("\r\n", "\n");
  const file = (name: string) => (existsSync(join(repo, name)) ? lf(readFileSync(join(repo, name), "utf8")) : undefined);

  await dispatch({
    type: "thread.create",
    commandId: id<CommandId>(),
    threadId,
    projectPath: repo,
    route: { harness: "fake", model: "fake", effort: "low" },
  });
  const t1 = await send("edit a.txt");
  const t2 = await send("edit new.txt");
  const t3 = await send("edit a.txt");
  const third = { a: file("a.txt"), new: file("new.txt") };
  expect(third.new).toBe("edited by the fake harness\n");
  expect((await rejected(revert(t3))).reason).toBe("InvalidRevert"); // nothing after the latest turn

  await dispatch(revert(t1));
  await settle();
  const reverted = await view();
  expect(reverted?.turns.map((t) => t.reverted)).toEqual([false, true, true]);
  expect(reverted?.revert).toEqual({ toTurnId: t1, files: true, undone: false });
  expect(file("a.txt")).toBe(lf(git(repo, "show", `${checkpointRef(threadId, t1, "end")}:a.txt`)));
  expect(file("new.txt")).toBeUndefined();
  expect(await outcome()).toEqual([{ status: "reverted" }]);

  await dispatch(undo());
  await settle();
  expect({ a: file("a.txt"), new: file("new.txt") }).toEqual(third);
  expect((await view())?.turns.map((t) => t.reverted)).toEqual([false, false, false]);
  expect(await outcome()).toEqual([{ status: "completed" }]);

  // Reverted again, the next turn forks the conversation after turn 1, dropping turn 2 onwards.
  await dispatch(revert(t1));
  await settle();
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
