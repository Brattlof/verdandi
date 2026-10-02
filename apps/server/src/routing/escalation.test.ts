import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, Item, Route, TaskOutcome, ThreadId, TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { loadThreadView } from "../event-store/projector.ts";
import { Reactor } from "../event-store/reactor.ts";
import { loadRoutingMemory } from "./routing-memory.ts";

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

/** Fails the first time it runs in a folder and passes after, like a test the agent's fix makes pass. */
const flakyOnce = `const fs = require("fs"); if (fs.existsSync("fixed")) process.exit(0); fs.writeFileSync("fixed", ""); console.log("1 fail"); process.exit(1);`;

/**
 * A project whose policy routes every task to the fake model at medium effort (`minConfidence: 1` sends all to
 * `fallback`), with `verifier`, and a thread on it: routed unless `pin` is given.
 */
const setup = async (verifier: string, pin?: Route) => {
  const projectPath = tempDir();
  mkdirSync(join(projectPath, ".verdandi"));
  writeFileSync(join(projectPath, "check.js"), flakyOnce);
  writeFileSync(
    join(projectPath, ".verdandi", "routing.yaml"),
    [
      "minConfidence: 1",
      "targets:",
      "  mid: { harness: fake, provider: fake, model: fake }",
      "  large: { harness: fake, provider: fake, model: fake-large }",
      "fallback: { prefer: [mid], effort: medium }",
      `escalation: { verifiers: ${JSON.stringify([verifier])} }`,
    ].join("\n"),
  );
  const runtime = ManagedRuntime.make(AppLayer(tempDir(), { fake: makeFakeHarness() }));
  runtimes.push(runtime as never);
  const dispatch = (c: Command) => runtime.runPromise(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  await dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId, projectPath, ...(pin && { route: pin }) });
  await dispatch({
    type: "turn.send",
    commandId: id<CommandId>(),
    threadId,
    turnId: id<TurnId>(),
    text: `edit ${join(projectPath, "a.txt")}`,
    mode: "build",
  });
  // The escalation's follow-up turn starts from the first turn's reactions, so drain until nothing runs.
  return runtime.runPromise(
    Effect.gen(function* () {
      yield* (yield* Reactor).drain;
      const view = yield* loadThreadView(threadId);
      const [row] = yield* (yield* SqlClient.SqlClient)<{ payload: string }>`select payload from task_outcomes`;
      return {
        view,
        outcome: row && (JSON.parse(row.payload) as TaskOutcome),
        memory: yield* loadRoutingMemory(threadId),
      };
    }),
  );
};

const escalations = (items: readonly Item[] | undefined) => (items ?? []).filter((i) => i.kind === "escalation");
const verifiers = (items: readonly Item[] | undefined) =>
  (items ?? []).flatMap((i) => (i.kind === "verifier" ? [i.passed ? "passed" : "failed"] : []));

test("a failing verifier raises the task's effort once, and failing again asks the user", async () => {
  const { view, outcome } = await setup("exit 1");
  const [first, second] = view?.turns ?? [];
  expect(view?.turns).toHaveLength(2);
  expect(verifiers(first?.items)).toEqual(["failed"]);
  expect(escalations(first?.items)).toMatchObject([
    {
      step: "effort",
      from: { model: "fake", effort: "medium" },
      to: { model: "fake", effort: "high" },
      nextTurnId: second?.turnId,
      reason: "`exit 1` failed (exit 1), so the task goes on at high effort, one step up from medium.",
    },
  ]);
  // Verdandi's turn hands the agent the failure as data.
  expect(second?.text).toStartWith("Verdandi ran the project's verifier `exit 1` after your changes, and it failed with exit code 1.");
  expect(verifiers(second?.items)).toEqual(["failed"]);
  expect(escalations(second?.items)).toMatchObject([{ step: "ask" }]);
  expect(escalations(second?.items)[0]).not.toHaveProperty("to");
  expect(view?.route).toMatchObject({ model: "fake", effort: "high" });
  // The route chip explains the route the task runs on now.
  expect(view?.task?.reason).toBe("`exit 1` failed (exit 1), so the task goes on at high effort, one step up from medium.");
  expect(outcome).toMatchObject({ status: "failed", escalations: 1, turns: 2, route: { effort: "medium" } });
});

test("an escalation that fixes the task completes it, and routing memory counts it against the route it started on", async () => {
  const { view, outcome, memory } = await setup(`"${process.execPath}" check.js`);
  expect(view?.turns.map((t) => verifiers(t.items))).toEqual([["failed"], ["passed"]]);
  expect(outcome).toMatchObject({ status: "completed", escalations: 1 });
  expect(memory).toMatchObject([{ route: { model: "fake", effort: "medium" }, tasks: 1, completed: 0, escalated: 1 }]);
});

test("a pinned thread never escalates: the user picked its route", async () => {
  const { view, outcome } = await setup("exit 1", { harness: "fake", model: "fake", effort: "medium" });
  expect(view?.turns).toHaveLength(1);
  expect(escalations(view?.turns[0]?.items)).toEqual([]);
  expect(outcome).toMatchObject({ status: "failed", escalations: 0 });
});
