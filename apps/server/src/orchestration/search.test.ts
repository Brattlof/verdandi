import { afterEach, expect, test } from "bun:test";
import type { Command, CommandId, ProjectId, SessionQuery, ThreadId, TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { migrations } from "../persistence/migrations.ts";
import { AppLayer } from "./app.ts";
import { projectIdFor } from "./decider.ts";
import { Engine } from "./engine.ts";
import { Reactor } from "./reactor.ts";
import { contextParts, searchSessions } from "./search.ts";

const dirs: string[] = [];
const runtimes: ManagedRuntime.ManagedRuntime<unknown, unknown>[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const d of dirs.splice(0)) removeTempHome(d);
});
let n = 0;
const id = <T>() => `id-${++n}` as T;
const route = { harness: "fake", model: "fake", effort: "low" } as const;

test("finds a phrase from an earlier thread in another project, archived or not, and the migration indexes what came before it", async () => {
  const home = makeTempHome();
  dirs.push(home);
  const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness() }));
  runtimes.push(runtime as never);
  const dispatch = (c: Command) => runtime.runPromise(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  const search = (q: SessionQuery) => runtime.runPromise(searchSessions(q));
  const thread = async (projectPath: string, text: string) => {
    const threadId = id<ThreadId>();
    await dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId, projectPath, route });
    await dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId: id<TurnId>(), text, mode: "build" });
    await runtime.runPromise(Effect.flatMap(Reactor, (r) => r.drain));
    return threadId;
  };
  const earlier = await thread("/work/payments", "Why does the Überweisung test in [id].tsx fail on Windows?");
  await thread("/work/blog", "Write a post");

  const hits = await search({ query: "uberweisung TEST" });
  expect(hits.map((h) => [h.threadId, h.kind, h.projectPath, h.archived])).toEqual([
    [earlier, "assistant", "/work/payments", false],
    [earlier, "user", "/work/payments", false],
  ]);
  expect(hits[1]?.parts).toEqual([
    { text: "Why does the ", match: false },
    { text: "Überweisung test", match: true },
    { text: " in [id].tsx fail on Windows?", match: false },
  ]);
  expect(hits[1]?.title).toBe("Why does the Überweisung test in [id].tsx fail on Windows?");
  // Input is a phrase, never FTS5 syntax: brackets, dots and quotes are text.
  expect(await search({ query: "[id].tsx" })).toHaveLength(2);
  expect(await search({ query: 'say "hi' })).toEqual([]);
  expect(await search({ query: "Überweisung", projectId: projectIdFor("/work/blog") as ProjectId })).toEqual([]);
  expect(await search({ query: "Üb" })).toEqual([]);

  await dispatch({ type: "thread.archive", commandId: id<CommandId>(), threadId: earlier });
  const archived = await search({ query: "Überweisung" });
  expect(archived.map((h) => h.archived)).toEqual([true, true]);

  const rebuilt = await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`drop table session_index`;
      yield* migrations["18_session_index"];
      return yield* searchSessions({ query: "Überweisung" });
    }),
  );
  expect(rebuilt).toEqual(archived);
});

test("a long message is cut to a little context either side of its match", () => {
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
  const parts = contextParts([...words.slice(0, 30), "\u0001needle\u0002", ...words.slice(30)].join(" "));
  const text = parts.map((p) => p.text).join("");
  expect(parts.filter((p) => p.match)).toEqual([{ text: "needle", match: true }]);
  expect(text.startsWith("…word")).toBe(true);
  expect(text.endsWith("…")).toBe(true);
  expect(text.length).toBeLessThan(200);
});
