import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, Item, TaskOutcome, ThreadId, TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { loadThreadView } from "../event-store/projector.ts";
import { Reactor } from "../event-store/reactor.ts";

const dirs: string[] = [];
const runtimes: ManagedRuntime.ManagedRuntime<unknown, unknown>[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const d of dirs.splice(0)) removeTempHome(d);
});
const tempDir = () => {
  const d = makeTempHome();
  dirs.push(d);
  return d;
};

let n = 0;
const id = <T>() => `id-${++n}` as T;
const threadId = "thread-1" as ThreadId;

/** A project whose routing policy sets `verifiers`, with one pinned thread on the fake harness. */
const setup = async (verifiers?: string[]) => {
  const projectPath = tempDir();
  if (verifiers) {
    mkdirSync(join(projectPath, ".verdandi"));
    writeFileSync(join(projectPath, ".verdandi", "routing.yaml"), `escalation:\n  verifiers: ${JSON.stringify(verifiers)}\n`);
  }
  const runtime = ManagedRuntime.make(AppLayer(tempDir(), { fake: makeFakeHarness() }));
  runtimes.push(runtime as never);
  const dispatch = (c: Command) => runtime.runPromise(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  await dispatch({
    type: "thread.create",
    commandId: id<CommandId>(),
    threadId,
    projectPath,
    route: { harness: "fake", model: "fake", effort: "low" },
  });
  /** Sends a turn and returns the turn and its task's outcome once everything it set off is done. */
  const turn = async (text: string) => {
    await dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId: id<TurnId>(), text, mode: "build" });
    return runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* Reactor).drain;
        const view = yield* loadThreadView(threadId);
        const [row] = yield* (yield* SqlClient.SqlClient)<{ payload: string }>`select payload from task_outcomes`;
        return { turn: view?.turns.at(-1), outcome: row && (JSON.parse(row.payload) as TaskOutcome) };
      }),
    );
  };
  return { projectPath, turn };
};

const verifierItems = (items: readonly Item[] | undefined) => (items ?? []).filter((i) => i.kind === "verifier");

test("a turn that edits a file runs the verifiers until one fails, and its task fails", async () => {
  const { projectPath, turn } = await setup(["echo checked", "exit 1", "echo never"]);
  const { turn: t, outcome } = await turn(`edit ${join(projectPath, "a.txt")}`);
  expect(t?.status).toBe("success");
  expect(verifierItems(t?.items)).toMatchObject([
    { kind: "verifier", command: "echo checked", passed: true, exitCode: 0 },
    { kind: "verifier", command: "exit 1", passed: false, exitCode: 1 },
  ]);
  expect(outcome).toMatchObject({
    status: "failed",
    verifierRuns: [
      { command: "echo checked", passed: true },
      { command: "exit 1", passed: false },
    ],
  });
});

test("passing verifiers leave the task completed", async () => {
  const { projectPath, turn } = await setup(["echo checked"]);
  const { outcome } = await turn(`edit ${join(projectPath, "a.txt")}`);
  expect(outcome).toMatchObject({ status: "completed", verifierRuns: [{ command: "echo checked", passed: true }] });
});

test("a turn that changes no files runs no verifiers", async () => {
  const { turn } = await setup(["exit 1"]);
  const { turn: t, outcome } = await turn("hello");
  expect(verifierItems(t?.items)).toEqual([]);
  expect(outcome).toMatchObject({ status: "completed", verifierRuns: [] });
});

test("a project without verifiers runs none", async () => {
  const { projectPath, turn } = await setup();
  const { turn: t } = await turn(`edit ${join(projectPath, "a.txt")}`);
  expect(verifierItems(t?.items)).toEqual([]);
});
