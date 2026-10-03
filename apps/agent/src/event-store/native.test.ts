import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, ThreadId, TurnId } from "@verdandi/contracts";
import { makeNativeAdapter, nativeCatalog } from "@verdandi/harness-native";
import { type FakeReply, makeFakeAnthropic, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Deferred, Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { threadDiff } from "../diffs/diff.ts";
import { alive } from "../home/home.ts";
import { catalogFor } from "../routing/routing.ts";
import { runShell } from "../verifiers/verify.ts";
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
    reach: { home, folders: [], readable: [join(home, "attachments")] },
    terminal: {
      run: (command, cwd, { timeoutMs, outputFile, signal }) =>
        Effect.runPromise(runShell(command, cwd, { timeoutMs, outputFile }), { signal }),
      outputs: join(home, "terminal-output"),
    },
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
    content: "You're planning: change nothing and run no command until the user approves your plan with propose_plan.",
  });
  expect(readFileSync(join(project, "rate.ts"), "utf8")).toBe("export const rate = 0.2;\n");
});

/** A native thread on the fake provider in its own project, whose approvals the test answers with `allow`. */
const terminalThread = async (script: (home: string) => readonly FakeReply[]) => {
  const home = makeTempHome();
  const project = makeTempHome();
  homes.push(home, project);
  const fake = makeFakeAnthropic(script(home));
  const runtime = ManagedRuntime.make(AppLayer(home, { native: nativeFor(home, fake.fetch) }));
  runtimes.push(runtime as never);
  const threadId = "thread-terminal" as ThreadId;
  const dispatch = (c: Command) => Effect.flatMap(Engine, (e) => e.dispatch(c));
  await runtime.runPromise(
    Effect.gen(function* () {
      const engine = yield* Engine;
      yield* engine.react((s) =>
        s.event.type === "approval.requested"
          ? engine
              .dispatch({
                type: "approval.respond",
                commandId: `allow-${s.event.requestId}` as CommandId,
                threadId,
                requestId: s.event.requestId,
                resolution: { decision: "allow" },
              })
              .pipe(Effect.ignore)
          : Effect.void,
      );
      yield* dispatch({
        type: "thread.create",
        commandId: "c1" as CommandId,
        threadId,
        projectPath: project,
        route: { harness: "native", model: "claude-sonnet-5-5", effort: "medium" },
      });
    }),
  );
  const send = (turnId: string, text: string) =>
    runtime.runPromise(
      dispatch({ type: "turn.send", commandId: `s-${turnId}` as CommandId, threadId, turnId: turnId as TurnId, text, mode: "build" }),
    );
  const settle = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        yield* Effect.flatMap(Reactor, (r) => r.drain);
        return (yield* loadThreadView(threadId))?.turns.at(-1);
      }),
    );
  return { home, project, threadId, dispatch: (c: Command) => runtime.runPromise(dispatch(c)), send, settle };
};

test("an approved terminal command runs in the thread's folder, and its whole output is where the result says, for read_file", async () => {
  const { home, send, settle } = await terminalThread((home) => [
    { blocks: [{ type: "tool_use", id: "toolu_t", name: "terminal", input: { command: "echo hello from the shell" } }] },
    { blocks: [{ type: "tool_use", id: "toolu_g", name: "grep", input: { pattern: "hello", path: join(home, "terminal-output") } }] },
    { blocks: [{ type: "text", text: "It said hello." }] },
  ]);
  await send("turn-1", "Say hello");
  const turn = await settle();
  expect(turn?.status).toBe("success");
  const result = turn?.items.find((i) => i.kind === "tool.result" && i.toolUseId === "toolu_t");
  const content = result?.kind === "tool.result" ? String(result.content) : "";
  expect(result).toMatchObject({ isError: false });
  expect(content).toMatch(/^Exit code 0 \(\d+\.\d s\)\.\nhello from the shell/);
  const file = /The whole output is at (.+); read it with read_file\./.exec(content)?.[1] ?? "";
  expect(file.startsWith(join(home, "terminal-output"))).toBe(true);
  expect(readFileSync(file, "utf8").trim()).toBe("hello from the shell");
  // The outputs folder is in the home, and still readable.
  expect(turn?.items).toContainEqual({
    kind: "tool.result",
    toolUseId: "toolu_g",
    isError: false,
    content: `${file}:1: hello from the shell`,
  });
});

test("interrupting a turn mid-command kills the command's whole process tree before the interrupt settles", async () => {
  const started = Promise.withResolvers<number[]>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      started.resolve((new URL(req.url).searchParams.get("pids") ?? "").split(",").map(Number));
      return new Response("ok");
    },
  });
  try {
    const { project, threadId, dispatch, send, settle } = await terminalThread(() => [
      {
        blocks: [
          {
            type: "tool_use",
            id: "toolu_t",
            name: "terminal",
            input: { command: `"${process.execPath}" tree.ts http://127.0.0.1:${server.port}/started` },
          },
        ],
      },
    ]);
    // A command that starts a child of its own, reports both, and keeps running.
    writeFileSync(
      join(project, "tree.ts"),
      [
        `const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);`,
        "await fetch(process.argv[2] + '?pids=' + process.pid + ',' + child.pid);",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    await send("turn-1", "Run the long thing");
    const pids = await started.promise;
    expect(pids.map(alive)).toEqual([true, true]);
    await dispatch({ type: "turn.interrupt", commandId: "i1" as CommandId, threadId, turnId: "turn-1" as TurnId });
    const turn = await settle();
    expect(turn?.status).toBe("interrupted");
    expect(pids.map(alive)).toEqual([false, false]);
  } finally {
    server.stop(true);
  }
});
