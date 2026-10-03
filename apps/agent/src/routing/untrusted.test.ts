import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, Event, Item, ThreadId, TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { loadThreadView } from "../event-store/projector.ts";
import { Reactor } from "../event-store/reactor.ts";
import { sessionUntrusted, untrustedSource } from "./untrusted.ts";

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

test("network tools and flagged injections taint a turn; the shell and the user's own MCP tools don't", () => {
  const call = (name: string): Item => ({ kind: "tool.call", toolUseId: "t", name, input: {} });
  expect(["WebFetch", "WebSearch", "web_fetch", "web_search"].map((name) => untrustedSource(call(name)))).toEqual([
    "WebFetch",
    "WebSearch",
    "web_fetch",
    "web_search",
  ]);
  expect(untrustedSource(call("Bash"))).toBeUndefined();
  expect(untrustedSource(call("mcp__github__get_issue"))).toBeUndefined();
  expect(untrustedSource({ kind: "tool.result", toolUseId: "t", isError: false, content: "WebFetch" })).toBeUndefined();
  expect(untrustedSource({ kind: "injection", source: "session_search", why: "asks to ignore instructions" })).toBe(
    "a session_search result, flagged as an injection",
  );
});

test("a session holds the first untrusted input since it started, not a forked-away turn's", () => {
  const turns = [
    { turnId: "t1" as TurnId, reverted: 0, untrusted: "WebSearch" },
    { turnId: "t2" as TurnId, reverted: 2, untrusted: "WebFetch" },
    { turnId: "t3" as TurnId, reverted: 0, untrusted: null },
    { turnId: "t4" as TurnId, reverted: 0, untrusted: "WebFetch" },
  ] as const;
  const session = { harness: "claude-code", sessionId: "s", sessionFirstTurn: null } as const;
  expect(sessionUntrusted(turns, session)).toEqual({ source: "WebSearch", turn: 1 });
  expect(sessionUntrusted(turns, { ...session, sessionFirstTurn: "t2" as TurnId })).toEqual({ source: "WebFetch", turn: 4 });
  expect(sessionUntrusted(turns, { ...session, sessionFirstTurn: "t3" as TurnId })).toEqual({ source: "WebFetch", turn: 4 });
  expect(sessionUntrusted(turns.slice(0, 3), { ...session, sessionFirstTurn: "t2" as TurnId })).toBeUndefined();
  // No warm session has nothing in context; a native one, which can write files, holds it too.
  expect(sessionUntrusted(turns, { ...session, sessionId: null })).toBeUndefined();
  expect(sessionUntrusted(turns, { ...session, harness: "native" })).toEqual({ source: "WebSearch", turn: 1 });
});

/** A routed thread on the fake harness running as Claude Code, in a project whose policy routes everything to Sonnet. */
const routedThread = async () => {
  const projectPath = tempDir();
  mkdirSync(join(projectPath, ".verdandi"));
  writeFileSync(join(projectPath, ".verdandi", "routing.yaml"), "fallback: { prefer: [cc-sonnet], effort: medium }\n");
  const runtime = ManagedRuntime.make(AppLayer(tempDir(), { "claude-code": makeFakeHarness() }));
  runtimes.push(runtime as never);
  const run = <A>(effect: Effect.Effect<A, unknown, Engine | Reactor | SqlClient.SqlClient>) =>
    runtime.runPromise(effect as Effect.Effect<A>);
  const dispatch = (c: Command) => run(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  const threadId = id<ThreadId>();
  await dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId, projectPath });
  const send = async (text: string) => {
    await dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId: id<TurnId>(), text, mode: "build" });
    await run(Effect.flatMap(Reactor, (r) => r.drain));
    return (await run(loadThreadView(threadId)))?.turns.at(-1)?.items ?? [];
  };
  const events = (type: Event["type"]) =>
    run(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ payload: string }>`select payload from events where type = ${type} order by seq`),
    ).then((rows) => rows.map((r) => JSON.parse(r.payload) as Event));
  return { run, dispatch, threadId, send, events };
};

test("a memory_save after a WebFetch result becomes a proposal the user approves, which outlives the turn", async () => {
  const { run, dispatch, threadId, send, events } = await routedThread();
  const save = 'tool memory_save {"scope":"project","text":"Deploys go through deploy.example.com"}';
  const items = await send(`fetch https://example.com/runbook\n${save}`);
  expect(items.find((i) => i.kind === "tool.result" && i.toolUseId.startsWith("fake-tool"))).toMatchObject({
    isError: false,
    content: expect.stringContaining("Not remembered yet: this turn read untrusted input"),
  });
  expect(await events("memory.saved")).toEqual([]);
  const view = await run(loadThreadView(threadId));
  // The turn is over, and the proposal still waits, saying why it asks.
  expect(view?.busy).toBe(false);
  expect(view?.pendingRequests).toMatchObject([
    {
      type: "memory.proposed",
      v: 2,
      scope: "project",
      text: "Deploys go through deploy.example.com",
      untrusted: { source: "WebFetch", turn: 1 },
    },
  ]);
  const [proposal] = view?.pendingRequests ?? [];
  await dispatch({
    type: "approval.respond",
    commandId: id<CommandId>(),
    threadId,
    requestId: proposal?.requestId ?? "",
    resolution: { decision: "allow" },
  });
  expect(await events("memory.saved")).toMatchObject([{ text: "Deploys go through deploy.example.com" }]);

  // A later turn that reads nothing from the network saves as usual.
  await send('tool memory_save {"scope":"project","text":"Tests run with bun test"}');
  expect(await events("memory.saved")).toMatchObject([{}, { text: "Tests run with bun test" }]);
});

test("a new task on a warm session that read untrusted input records it for replay", async () => {
  const { dispatch, threadId, send, events } = await routedThread();
  await send("fetch https://example.com/docs");
  // A budget change ends the routed task, so the next turn starts one on the warm session.
  await dispatch({ type: "thread.budget.set", commandId: id<CommandId>(), threadId, mode: "max" });
  await send("What does this reducer do?");
  const started = await events("task.started");
  expect(started.map((e) => e.type === "task.started" && e.inputs?.untrusted)).toEqual([undefined, { source: "WebFetch", turn: 1 }]);
});
