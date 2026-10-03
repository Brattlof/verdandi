import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, ThreadId, TurnId } from "@verdandi/contracts";
import { makeNativeAdapter, nativeCatalog } from "@verdandi/harness-native";
import { makeFakeAnthropic, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Deferred, Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { threadDiff } from "../diffs/diff.ts";
import { catalogFor } from "../routing/routing.ts";
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

/** The native adapter on the fake provider, with every cache break thrown. */
const nativeFor = (home: string, fetch: typeof globalThis.fetch) =>
  makeNativeAdapter({
    apiKey: "sk-ant-test",
    sessionsDir: join(home, "native-sessions"),
    reach: { home, folders: [], attachments: join(home, "attachments") },
    fetch,
    cacheBreaks: "throw",
  });

test("verdandid runs a native turn end to end: streamed text, a Verdandi tool the user approves, usage priced as metered", async () => {
  const home = makeTempHome();
  homes.push(home);
  // The user approves each memory save, so memory_save asks first.
  writeFileSync(join(home, "memory.yaml"), "approveSaves: true\n");
  const fake = makeFakeAnthropic([
    {
      blocks: [
        { type: "text", text: "I'll remember that." },
        { type: "tool_use", id: "toolu_1", name: "memory_save", input: { scope: "user", text: "Prefers tea over coffee." } },
      ],
      usage: { input: 2000, output: 60, cacheWrite: 1500 },
    },
    { blocks: [{ type: "text", text: "Saved." }], usage: { input: 30, output: 5, cacheRead: 3500 } },
  ]);
  const native = nativeFor(home, fake.fetch);
  const runtime = ManagedRuntime.make(AppLayer(home, { native }));
  runtimes.push(runtime as never);
  const threadId = "thread-native" as ThreadId;
  const turnId = "turn-native" as TurnId;
  const dispatch = (c: Command) => Effect.flatMap(Engine, (e) => e.dispatch(c));

  const { view, ledger, memories } = await runtime.runPromise(
    Effect.gen(function* () {
      const raised = yield* Deferred.make<string>();
      yield* (yield* Engine).react((s) =>
        s.event.type === "approval.requested" ? Deferred.succeed(raised, s.event.requestId) : Effect.void,
      );
      yield* dispatch({
        type: "thread.create",
        commandId: "c1" as CommandId,
        threadId,
        projectPath: home,
        route: { harness: "native", model: "claude-sonnet-5-5", effort: "medium" },
      });
      yield* dispatch({
        type: "turn.send",
        commandId: "c2" as CommandId,
        threadId,
        turnId,
        text: "Remember that I prefer tea",
        mode: "build",
      });
      const requestId = yield* Deferred.await(raised);
      yield* dispatch({ type: "approval.respond", commandId: "c3" as CommandId, threadId, requestId, resolution: { decision: "allow" } });
      yield* Effect.flatMap(Reactor, (r) => r.drain);
      const sql = yield* SqlClient.SqlClient;
      return {
        view: yield* loadThreadView(threadId),
        ledger: yield* sql<{ model: string; access_mode: string; cost_usd: number }>`select model, access_mode, cost_usd from usage_ledger`,
        memories: yield* sql<{ text: string }>`select text from memories`,
      };
    }),
  );

  const turn = view?.turns.at(-1);
  expect(turn?.status).toBe("success");
  expect(turn?.items).toEqual([
    { kind: "assistant.message", text: "I'll remember that." },
    { kind: "tool.call", toolUseId: "toolu_1", name: "memory_save", input: { scope: "user", text: "Prefers tea over coffee." } },
    { kind: "tool.result", toolUseId: "toolu_1", isError: false, content: expect.any(String) },
    { kind: "assistant.message", text: "Saved." },
  ]);
  expect(memories.map((m) => m.text)).toEqual(["Prefers tea over coffee."]);
  expect(view?.sessionId).toEqual(expect.any(String));
  // Every request is metered, at the catalog's list price for the model it ran on.
  expect(ledger.map((u) => [u.model, u.access_mode])).toEqual([
    ["claude-sonnet-5-5", "metered"],
    ["claude-sonnet-5-5", "metered"],
  ]);
  const price = nativeCatalog.find((e) => e.model === "claude-sonnet-5-5")?.price;
  expect(ledger[0]?.cost_usd).toBeCloseTo(
    ((price?.input ?? 0) * 2000 + (price?.output ?? 0) * 60 + (price?.cacheWrite ?? 0) * 1500) / 1e6,
    10,
  );
});

test("the native harness's models join the catalog only while it runs", () => {
  const native = (c: ReturnType<typeof catalogFor>) => c.filter((e) => e.harness === "native").map((e) => e.model);
  expect(native(catalogFor({ "claude-code": {} }))).toEqual([]);
  expect(native(catalogFor({ "claude-code": {}, native: {} }))).toEqual(nativeCatalog.map((e) => e.model));
});

test("a native turn reads and edits a file, and the turn's diff shows it; in plan mode the same edit is refused", async () => {
  const home = makeTempHome();
  const project = makeTempHome();
  homes.push(home, project);
  Bun.spawnSync(["git", "init", "--quiet"], { cwd: project });
  writeFileSync(join(project, "rate.ts"), "export const rate = 0.1;\n");
  const edit = { path: "rate.ts", old_string: "0.1", new_string: "0.2" };
  const fake = makeFakeAnthropic([
    { blocks: [{ type: "tool_use", id: "toolu_r", name: "read_file", input: { path: "rate.ts" } }] },
    { blocks: [{ type: "tool_use", id: "toolu_e", name: "edit_file", input: edit }] },
    { blocks: [{ type: "text", text: "Raised it." }] },
    { blocks: [{ type: "tool_use", id: "toolu_p", name: "edit_file", input: { ...edit, new_string: "0.3" } }] },
    { blocks: [{ type: "text", text: "I'll plan first." }] },
  ]);
  const runtime = ManagedRuntime.make(AppLayer(home, { native: nativeFor(home, fake.fetch) }));
  runtimes.push(runtime as never);
  const threadId = "thread-files" as ThreadId;
  const dispatch = (c: Command) => Effect.flatMap(Engine, (e) => e.dispatch(c));
  const send = (n: number, mode: "build" | "plan") =>
    Effect.andThen(
      dispatch({
        type: "turn.send",
        commandId: `s${n}` as CommandId,
        threadId,
        turnId: `turn-${n}` as TurnId,
        text: "Raise the rate",
        mode,
      }),
      Effect.flatMap(Reactor, (r) => r.drain),
    );

  const { built, planned, diff } = await runtime.runPromise(
    Effect.gen(function* () {
      yield* dispatch({
        type: "thread.create",
        commandId: "c1" as CommandId,
        threadId,
        projectPath: project,
        route: { harness: "native", model: "claude-sonnet-5-5", effort: "medium" },
      });
      yield* send(1, "build");
      const built = (yield* loadThreadView(threadId))?.turns.at(-1);
      const diff = yield* threadDiff(threadId, "turn-1" as TurnId);
      yield* send(2, "plan");
      return { built, planned: (yield* loadThreadView(threadId))?.turns.at(-1), diff };
    }),
  );

  expect(built?.status).toBe("success");
  expect(built?.items).toContainEqual({
    kind: "tool.result",
    toolUseId: "toolu_r",
    isError: false,
    content: "1\texport const rate = 0.1;",
  });
  expect(diff.files.map((f) => f.path)).toEqual(["rate.ts"]);
  expect(diff.files[0]?.diff).toContain("+export const rate = 0.2;");
  expect(planned?.items).toContainEqual({
    kind: "tool.result",
    toolUseId: "toolu_p",
    isError: true,
    content: "You're planning: change no file until the user approves your plan with propose_plan.",
  });
  expect(readFileSync(join(project, "rate.ts"), "utf8")).toBe("export const rate = 0.2;\n");
});
