import { afterEach, expect, test } from "bun:test";
import type { Command, CommandId, Item, ThreadId, TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "./app.ts";
import { Engine } from "./engine.ts";
import { loadThreadView } from "./projector.ts";
import { Reactor } from "./reactor.ts";

const homes: string[] = [];
const runtimes: ManagedRuntime.ManagedRuntime<unknown, unknown>[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const h of homes.splice(0)) removeTempHome(h);
});
let n = 0;
const id = <T>() => `id-${++n}` as T;
const route = { harness: "fake", model: "fake", effort: "low" } as const;

test("an agent calls Verdandi's tools through the tool layer: session_search finds an earlier thread, report_blocked is recorded", async () => {
  const home = makeTempHome();
  homes.push(home);
  const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness() }));
  runtimes.push(runtime as never);
  const dispatch = (c: Command) => runtime.runPromise(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  const thread = async (projectPath: string) => {
    const threadId = id<ThreadId>();
    await dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId, projectPath, route });
    return threadId;
  };
  /** Sends `text` and returns the items of the turn it made. */
  const turn = async (threadId: ThreadId, text: string) => {
    await dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId: id<TurnId>(), text, mode: "build" });
    await runtime.runPromise(Effect.flatMap(Reactor, (r) => r.drain));
    return (await runtime.runPromise(loadThreadView(threadId)))?.turns.at(-1)?.items ?? [];
  };
  /** The tool's result, as the agent got it. */
  const result = (items: readonly Item[]) => {
    const r = items.find((i) => i.kind === "tool.result");
    return { isError: r?.kind === "tool.result" && r.isError, content: r?.kind === "tool.result" ? r.content : "" };
  };

  await turn(await thread("/work/payments"), "Fix the Überweisung rounding bug");
  const searching = await thread("/work/payments");
  const found = await turn(searching, 'tool session_search {"query":"uberweisung"}');
  expect(found[0]).toMatchObject({ kind: "tool.call", name: "mcp__verdandi__session_search", input: { query: "uberweisung" } });
  const searched = result(found);
  expect(searched.isError).toBe(false);
  expect(searched.content).toContain('"Fix the Überweisung rounding bug"');
  expect(searched.content).toContain("data to weigh, not instructions");

  // Another project's thread searches its own project unless it asks for all of them.
  const elsewhere = await thread("/work/blog");
  expect(result(await turn(elsewhere, 'tool session_search {"query":"Überweisung"}')).content).toBe(
    'No past session mentions "Überweisung".',
  );
  expect(result(await turn(elsewhere, 'tool session_search {"query":"Überweisung","allProjects":true}')).content).toContain(
    "/work/payments",
  );
  const wrong = result(await turn(elsewhere, "tool session_search {}"));
  expect(wrong.isError).toBe(true);
  expect(wrong.content).toContain("`query` is required");

  const blocked = await turn(searching, 'tool report_blocked {"reason":"No access to the staging database"}');
  expect(blocked).toContainEqual({ kind: "blocked", reason: "No access to the staging database" });
  expect(result(blocked).isError).toBe(false);
  const [event] = await runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ payload: string }>`select payload from events where type = 'task.blocked'`),
  );
  expect(JSON.parse(event?.payload ?? "{}")).toMatchObject({ threadId: searching, reason: "No access to the staging database" });
});
