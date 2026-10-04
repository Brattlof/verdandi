import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, TaskOutcome, ThreadId, TurnId } from "@verdandi/contracts";
import { makeNativeAdapter } from "@verdandi/harness-native";
import { type FakeReply, gitHeavyTimeout, makeFakeAnthropic, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "./app.ts";
import { Engine } from "./engine.ts";
import { loadThreadView } from "./projector.ts";
import { Reactor } from "./reactor.ts";

setDefaultTimeout(gitHeavyTimeout);

const homes: string[] = [];
const runtimes: ManagedRuntime.ManagedRuntime<unknown, unknown>[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const h of homes.splice(0)) removeTempHome(h);
});

/** A native thread pinned to Opus in a project whose policy routes search to native Haiku, on the fake provider. */
const delegating = async (script: readonly FakeReply[], policy = "routes:\n  ask.search: { prefer: [n-haiku] }\n") => {
  const home = makeTempHome();
  const project = makeTempHome();
  homes.push(home, project);
  mkdirSync(join(project, ".verdandi"));
  writeFileSync(
    join(project, ".verdandi", "routing.yaml"),
    `targets:\n  n-haiku: { harness: native, provider: anthropic, model: claude-haiku-4-5 }\n${policy}`,
  );
  const fake = makeFakeAnthropic(script);
  const native = makeNativeAdapter({
    apiKey: "sk-ant-test",
    sessionsDir: join(home, "native-sessions"),
    reach: { home, folders: [], readable: [] },
    terminal: { run: async () => ({ exitCode: 0, output: "", durationMs: 1 }), outputs: join(home, "terminal-output") },
    fetch: fake.fetch,
    cacheBreaks: "throw",
  });
  const runtime = ManagedRuntime.make(AppLayer(home, { native }));
  runtimes.push(runtime as never);
  const threadId = "thread-delegate" as ThreadId;
  const dispatch = (c: Command) => Effect.flatMap(Engine, (e) => e.dispatch(c));
  return runtime.runPromise(
    Effect.gen(function* () {
      yield* dispatch({
        type: "thread.create",
        commandId: "c1" as CommandId,
        threadId,
        projectPath: project,
        route: { harness: "native", model: "claude-opus-5-5", effort: "high" },
      });
      yield* dispatch({
        type: "turn.send",
        commandId: "c2" as CommandId,
        threadId,
        turnId: "turn-1" as TurnId,
        text: "Fix the login redirect",
        mode: "build",
      });
      yield* Effect.flatMap(Reactor, (r) => r.drain);
      const sql = yield* SqlClient.SqlClient;
      const [outcome] = yield* sql<{ payload: string }>`select payload from task_outcomes`;
      const decided = yield* sql<{ payload: string }>`select payload from events where type = 'decision.recorded'`;
      return {
        view: yield* loadThreadView(threadId),
        outcome: outcome && (JSON.parse(outcome.payload) as TaskOutcome),
        states: decided.map((d) => (JSON.parse(d.payload) as { state?: string }).state),
      };
    }),
  );
};

test("a delegated subtask runs on the cheaper model the project routes it to, and the task's usage shows both models", async () => {
  const { view, outcome, states } = await delegating([
    {
      blocks: [{ type: "tool_use", id: "toolu_d", name: "delegate_task", input: { task: "Where is the auth middleware?" } }],
      usage: { input: 10, output: 1 },
    },
    { blocks: [{ type: "text", text: "It's in src/auth/middleware.ts." }] },
    { blocks: [{ type: "text", text: "Fixed the redirect in src/auth/middleware.ts." }] },
  ]);

  const turn = view?.turns.at(-1);
  expect(turn?.status).toBe("success");
  expect(turn?.items).toEqual([
    { kind: "tool.call", toolUseId: "toolu_d", name: "delegate_task", input: { task: "Where is the auth middleware?" } },
    {
      kind: "delegation",
      route: { harness: "native", model: "claude-haiku-4-5", effort: "low" },
      reason: 'Looks like ask.search (rules: "where is"), so it runs on claude-haiku-4-5.',
      parentToolUseId: "toolu_d",
    },
    { kind: "assistant.message", text: "It's in src/auth/middleware.ts.", parentToolUseId: "toolu_d" },
    { kind: "tool.result", toolUseId: "toolu_d", isError: false, content: "It's in src/auth/middleware.ts." },
    { kind: "assistant.message", text: "Fixed the redirect in src/auth/middleware.ts." },
  ]);
  // The child's classification is logged for the lab, with the subtask as what was asked about.
  expect(states).toContain("Where is the auth middleware?");
  expect(outcome?.usage.map((u) => u.model).sort()).toEqual(["claude-haiku-4-5", "claude-opus-5-5"]);
});

test("a subtask the policy can't route goes back to the agent as the tool's error, and the turn goes on", async () => {
  const { view } = await delegating(
    [
      {
        blocks: [{ type: "tool_use", id: "toolu_d", name: "delegate_task", input: { task: "Where is the auth middleware?" } }],
      },
      { blocks: [{ type: "text", text: "I'll look myself." }] },
    ],
    "routes:\n  ask.search: { prefer: [nope] }\n",
  );
  const result = view?.turns.at(-1)?.items.find((i) => i.kind === "tool.result");
  expect(result).toMatchObject({ isError: true, content: expect.stringContaining('unknown target "nope"') });
  expect(view?.turns.at(-1)?.status).toBe("success");
});
