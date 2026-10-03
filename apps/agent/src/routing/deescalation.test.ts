import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, Route, TaskOutcome, ThreadId, Trajectory, TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { loadThreadView } from "../event-store/projector.ts";
import { Reactor } from "../event-store/reactor.ts";
import { allowTrustRequests } from "../trust/allow-trust.ts";

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
const opus: Route = { harness: "claude-code", model: "opus", effort: "high" };

/**
 * A thread whose first turn edits a file on Opus (the fake harness runs as Claude Code, so the catalog's prices apply)
 * and passes the project's verifier, then asks for a commit message: routed unless `pin` is given. With `fetch`, the
 * first turn reads a web page through WebFetch before it edits.
 */
const buildThenCommit = async (pin?: Route, fetch?: string) => {
  const projectPath = tempDir();
  mkdirSync(join(projectPath, ".verdandi"));
  writeFileSync(
    join(projectPath, ".verdandi", "routing.yaml"),
    ["fallback: { prefer: [cc-opus], effort: high }", 'escalation: { verifiers: ["exit 0"] }'].join("\n"),
  );
  const runtime = ManagedRuntime.make(AppLayer(tempDir(), { "claude-code": makeFakeHarness() }));
  runtimes.push(runtime as never);
  await runtime.runPromise(allowTrustRequests);
  const run = <A>(effect: Effect.Effect<A, unknown, Engine | Reactor>) => runtime.runPromise(effect as Effect.Effect<A>);
  const dispatch = (c: Command) => run(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  const send = async (text: string) => {
    await dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId: id<TurnId>(), text, mode: "build" });
    await run(Effect.flatMap(Reactor, (r) => r.drain));
  };
  await dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId, projectPath, ...(pin && { route: pin }) });
  await send(
    `${
      fetch
        ? `fetch ${fetch}
`
        : ""
    }edit ${join(projectPath, "a.txt")}`,
  );
  await send("Write a commit message for these changes");
  return runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [outcome] = yield* sql<{ payload: string }>`select payload from task_outcomes`;
      const trajectories = yield* sql<{ payload: string }>`select payload from trajectories order by rowid`;
      return {
        view: yield* loadThreadView(threadId),
        outcome: outcome && (JSON.parse(outcome.payload) as TaskOutcome),
        ran: trajectories.map((t) => (JSON.parse(t.payload) as Trajectory).route.model),
      };
    }),
  );
};

test("a chore after a turn whose verifiers passed moves the rest of the task to a cheaper model, shown between the turns", async () => {
  const { view, outcome, ran } = await buildThenCommit();
  const [build, commit] = view?.turns ?? [];
  expect(build?.items.filter((i) => i.kind === "verifier")).toMatchObject([{ command: "exit 0", passed: true }]);
  expect(view?.routeChanges).toMatchObject([
    {
      by: "router",
      from: opus,
      to: { harness: "claude-code", model: "haiku", effort: "low" },
      afterTurns: 1,
      reason: "The verifiers passed and what's left looks like chore.git, so it runs on haiku.",
    },
  ]);
  // The chore ran on the cheaper model, in the same task, and the thread stays routed.
  expect(commit?.usage.map((u) => u.model)).toEqual(["haiku"]);
  expect(view?.tasks).toHaveLength(1);
  expect(view).toMatchObject({ pinned: false, route: { model: "haiku", effort: "low" } });
  expect(view?.task?.reason).toBe("The verifiers passed and what's left looks like chore.git, so it runs on haiku.");
  // Routing memory counts the task on the route it started on, and the router's move isn't the user's override.
  expect(outcome).toMatchObject({ status: "completed", turns: 2, escalations: 0, route: opus });
  expect(outcome).not.toHaveProperty("userOverride");
  expect(ran).toEqual(["opus", "haiku"]);
});

test("a session that read a web page de-escalates no lower than the untrusted-input floor, and says why", async () => {
  const { view } = await buildThenCommit(undefined, "https://example.com/changelog");
  const reason =
    "The verifiers passed and what's left looks like chore.git, but this session read untrusted input (WebFetch, turn 1), so it runs on sonnet at low effort.";
  expect(view?.routeChanges).toMatchObject([{ by: "router", from: opus, to: { model: "sonnet", effort: "low" }, reason }]);
  expect(view?.turns.map((t) => t.usage.map((u) => u.model))).toEqual([["opus"], ["sonnet"]]);
});

test("a pinned thread never de-escalates: the user picked its route", async () => {
  const { view } = await buildThenCommit(opus);
  expect(view?.routeChanges).toEqual([]);
  expect(view?.turns.map((t) => t.usage.map((u) => u.model))).toEqual([["opus"], ["opus"]]);
  expect(view).toMatchObject({ pinned: true, route: opus });
});
