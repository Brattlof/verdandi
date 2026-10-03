import { afterEach, expect, test } from "bun:test";
import { type Command, type CommandId, type Item, type ThreadId, Trajectory, type TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { loadThreadView } from "../event-store/projector.ts";
import { Reactor } from "../event-store/reactor.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) removeTempHome(h);
});

const threadId = "thread-1" as ThreadId;
const route = { harness: "fake", model: "fake", effort: "low" } as const;

const drain = Effect.flatMap(Reactor, (reactor) => reactor.drain);

/** Runs `effect` against a verdandid on `home`, once its startup work has finished. */
const withApp = <A, E>(home: string, effect: Effect.Effect<A, E, Engine | Reactor | SqlClient.SqlClient>) => {
  const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness() }));
  return runtime.runPromise(Effect.andThen(drain, effect)).finally(() => runtime.dispose());
};

const dispatch = (c: Command) => Effect.flatMap(Engine, (engine) => engine.dispatch(c));
const runTurn = (text: string) =>
  Effect.gen(function* () {
    const turnId = crypto.randomUUID() as TurnId;
    yield* dispatch({ type: "turn.send", commandId: crypto.randomUUID() as CommandId, threadId, turnId, text, mode: "build" });
    yield* drain;
    return turnId;
  });
const trajectories = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ turn_id: string; provider: string; payload: string }>`
  select turn_id, provider, payload from trajectories`,
).pipe(
  Effect.map((rows) => rows.map((r) => ({ ...r, trajectory: Schema.decodeUnknownSync(Schema.fromJsonString(Trajectory))(r.payload) }))),
);
const newHome = () => {
  const home = makeTempHome();
  homes.push(home);
  return home;
};
const create = dispatch({ type: "thread.create", commandId: crypto.randomUUID() as CommandId, threadId, projectPath: "/repo", route });

test("a completed turn's trajectory reads back with its provenance, and includes its subagent's steps", async () => {
  const [echo, delegated] = await withApp(
    newHome(),
    Effect.gen(function* () {
      yield* create;
      const echoTurn = yield* runTurn("hi");
      const subagentTurn = yield* runTurn("subagent");
      const rows = yield* trajectories;
      return [echoTurn, subagentTurn].map((turnId) => rows.find((r) => r.turn_id === turnId));
    }),
  );
  expect(echo?.provider).toBe("fake");
  expect(echo?.trajectory).toMatchObject({
    route,
    provenance: { provider: "fake", harnessVersion: "fake", accessMode: "subscription" },
    transcript: { sessionId: "fake-session-1" },
    text: "hi",
    items: [{ kind: "assistant.message", text: "echo: hi" }],
    usage: [{ model: "fake", outputTokens: 5 }],
    outcome: { status: "success" },
  });
  const subagentSteps = delegated?.trajectory.items.filter((i) => "parentToolUseId" in i && i.parentToolUseId === "fake-agent-1");
  expect(subagentSteps?.map((i) => i.kind)).toEqual(["tool.call", "tool.result", "assistant.message"]);
});

test("a background subagent's steps land under the turn that started it, in the thread view and the trajectory", async () => {
  const [turnId, view, rows] = await withApp(
    newHome(),
    Effect.gen(function* () {
      yield* create;
      const id = yield* runTurn("background");
      yield* runTurn("hi");
      return [id, yield* loadThreadView(threadId), yield* trajectories] as const;
    }),
  );
  const underAgent = (items: readonly Item[] | undefined) =>
    items?.filter((i) => "parentToolUseId" in i && i.parentToolUseId === "fake-agent-1").map((i) => i.kind);
  const turn = view?.turns.find((t) => t.turnId === turnId);
  expect(turn?.status).toBe("success");
  expect(underAgent(turn?.items)).toEqual(["tool.call", "tool.result", "assistant.message"]);
  expect(turn?.items.at(-1)).toEqual({ kind: "assistant.message", text: "the background subagent read a.txt" });
  expect(underAgent(rows.find((r) => r.turn_id === turnId)?.trajectory.items)).toEqual(["tool.call", "tool.result", "assistant.message"]);
  expect(view?.turns.filter((t) => t.turnId !== turnId).flatMap((t) => underAgent(t.items) ?? [])).toEqual([]);
});

test("a turn left without a trajectory gets one when verdandid next starts", async () => {
  const home = newHome();
  const turnId = await withApp(
    home,
    Effect.gen(function* () {
      yield* create;
      const id = yield* runTurn("fail");
      yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`delete from trajectories`); // as if verdandid died before writing it
      return id;
    }),
  );
  const rows = await withApp(home, trajectories);
  expect(rows.map((r) => [r.turn_id, r.trajectory.outcome])).toEqual([[turnId, { status: "error", error: "fake failure" }]]);
});
