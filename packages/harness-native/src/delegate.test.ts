import { afterEach, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { HarnessEvent, HarnessRunInput, HarnessTool, Route, ThreadId, TurnId } from "@verdandi/contracts";
import { type FakeReply, makeFakeAnthropic, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, Fiber, Stream } from "effect";
import { makeNativeAdapter } from "./adapter.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) removeTempHome(h);
});

const opus: Route = { harness: "native", model: "claude-opus-5-5", effort: "high" };
const haiku: Route = { harness: "native", model: "claude-haiku-4-5", effort: "low" };
const threadId = "thread-1" as ThreadId;

/** A Verdandi tool that asks first, and one a child never gets. */
const tools: HarnessTool[] = [
  { name: "memory_save", description: "Saves a fact.", params: {}, ask: true, call: async () => ({ text: "Saved." }) },
  { name: "report_blocked", description: "Reports a blocker.", params: {}, call: async () => ({ text: "Reported." }) },
];

const setup = (script: readonly FakeReply[]) => {
  const home = makeTempHome();
  homes.push(home);
  const fake = makeFakeAnthropic(script);
  const adapter = makeNativeAdapter({
    apiKey: "sk-ant-test",
    sessionsDir: `${home}/native-sessions`,
    reach: { home, folders: [], readable: [] },
    terminal: { run: async () => ({ exitCode: 0, output: "", durationMs: 1 }), outputs: `${home}/terminal-output` },
    fetch: fake.fetch,
    cacheBreaks: "throw",
  });
  return { fake, adapter };
};

type Call = Parameters<NonNullable<HarnessRunInput["delegate"]>["route"]>[0];

const input = (delegate: NonNullable<HarnessRunInput["delegate"]>, more: Partial<HarnessRunInput> = {}): HarnessRunInput => ({
  threadId,
  cwd: "/work/payments",
  route: opus,
  resumeSessionId: undefined,
  turnId: "t1" as TurnId,
  text: "Fix the login bug",
  mode: "build",
  steers: Stream.empty,
  tools,
  delegate,
  ...more,
});

const delegate = (task: string, id = "toolu_d", profile?: string): FakeReply => ({
  blocks: [{ type: "tool_use", id, name: "delegate_task", input: { task, ...(profile && { profile }) } }],
  usage: { input: 10, output: 1 },
});
const say = (text: string, usage = { input: 100, output: 20 }): FakeReply => ({ blocks: [{ type: "text", text }], usage });

const toolNames = (body: Record<string, unknown> | undefined) => (body?.tools as Anthropic.Tool[] | undefined)?.map((t) => t.name);
const firstText = (body: Record<string, unknown> | undefined) =>
  JSON.stringify((body?.messages as Anthropic.MessageParam[] | undefined)?.[0]?.content);

const collect = (adapter: ReturnType<typeof makeNativeAdapter>, turn: HarnessRunInput, on: (e: HarnessEvent) => void = () => {}) =>
  Effect.runPromise(Stream.runCollect(Stream.tap(adapter.run(turn), (e) => Effect.sync(() => on(e))))).then((events) => Array.from(events));

test("the agent delegates a subtask to a cheaper model, whose summary is the tool's result and whose usage is the turn's", async () => {
  const { fake, adapter } = setup([
    delegate("Find where the auth middleware is, and report its path."),
    // The child, on Haiku: a tool that asks, then its summary.
    { blocks: [{ type: "tool_use", id: "toolu_c", name: "memory_save", input: {} }], usage: { input: 50, output: 5 } },
    say("Found it: src/auth/middleware.ts."),
    say("The middleware is in src/auth/middleware.ts."),
  ]);
  const calls: Call[] = [];
  const events = await collect(
    adapter,
    input({
      route: async (call) => {
        calls.push(call);
        return { route: haiku };
      },
      maxConcurrent: 3,
      maxDepth: 1,
    }),
    // The child's request surfaces on the parent's turn and is answered there.
    (e) => {
      if (e.type === "approval.requested") void Effect.runPromise(adapter.respond(threadId, e.requestId, { decision: "allow" }));
    },
  );

  expect(calls).toEqual([{ toolUseId: "toolu_d", task: "Find where the auth middleware is, and report its path." }]);
  expect(events).toContainEqual({
    type: "item",
    item: { kind: "tool.result", toolUseId: "toolu_d", isError: false, content: "Found it: src/auth/middleware.ts." },
  });
  // The child's steps are the call's subagent steps; its text doesn't stream as the parent's.
  expect(events).toContainEqual({
    type: "item",
    item: { kind: "assistant.message", text: "Found it: src/auth/middleware.ts.", parentToolUseId: "toolu_d" },
  });
  expect(events).toContainEqual({ type: "item", item: expect.objectContaining({ kind: "tool.call", parentToolUseId: "toolu_d" }) });
  expect(events.some((e) => e.type === "approval.requested" && e.toolName === "memory_save")).toBe(true);
  expect(
    events
      .filter((e) => e.type === "text.delta")
      .map((e) => (e.type === "text.delta" ? e.text : ""))
      .join(""),
  ).toBe("The middleware is in src/auth/middleware.ts.");
  expect(events.filter((e) => e.type === "session.started")).toHaveLength(1);
  expect(new Set(events.flatMap((e) => (e.type === "usage" ? [e.model] : [])))).toEqual(new Set(["claude-opus-5-5", "claude-haiku-4-5"]));
  expect(events.at(-1)).toEqual({ type: "turn.finished", status: "success" });

  // The child is a session of its own on Haiku: the parent's system prompt, without delegate_task or report_blocked.
  const [parent, child] = fake.requests.map((r) => r.body);
  expect(child?.model).toBe("claude-haiku-4-5");
  expect(child?.system).toEqual(parent?.system);
  expect(toolNames(parent)).toContain("delegate_task");
  expect(toolNames(child)).not.toContain("delegate_task");
  expect(toolNames(child)).not.toContain("report_blocked");
  expect(firstText(child)).toContain("you're a subagent");
  expect(firstText(child)).toContain("build mode");
});

test("children of one reply run at once, a profile works read-only, and results come back in the calls' order", async () => {
  const { fake, adapter } = setup([
    {
      blocks: [
        { type: "tool_use", id: "toolu_a", name: "delegate_task", input: { task: "Rename foo to bar in a.ts" } },
        { type: "tool_use", id: "toolu_b", name: "delegate_task", input: { task: "Review a.ts", profile: "reviewer" } },
      ],
      usage: { input: 10, output: 1 },
    },
    say("Renamed."),
    say("Looks fine."),
    say("Both done."),
  ]);
  const pending: { readonly call: Call; readonly answer: (r: { route: Route }) => void }[] = [];
  const both = Promise.withResolvers<void>();
  const run = collect(
    adapter,
    input({
      route: (call) =>
        new Promise((answer) => {
          pending.push({ call, answer });
          if (pending.length === 2) both.resolve();
        }),
      maxConcurrent: 2,
      maxDepth: 1,
    }),
  );
  // Both are routed before either child has run.
  await both.promise;
  pending[0]?.answer({ route: haiku });
  await fake.arrived(2);
  pending[1]?.answer({ route: haiku });
  const events = await run;

  expect(pending.map((p) => p.call)).toEqual([
    { toolUseId: "toolu_a", task: "Rename foo to bar in a.ts" },
    { toolUseId: "toolu_b", task: "Review a.ts", profile: "reviewer" },
  ]);
  const results = events.flatMap((e) => (e.type === "item" && e.item.kind === "tool.result" ? [[e.item.toolUseId, e.item.content]] : []));
  expect(results).toEqual([
    ["toolu_a", "Renamed."],
    ["toolu_b", "Looks fine."],
  ]);
  expect(firstText(fake.requests[1]?.body)).toContain("build mode");
  expect(firstText(fake.requests[2]?.body)).toContain("ask mode");
});

test("a child's spend counts against the task's maxCost, and interrupting the parent stops its child", async () => {
  // Opus at 10 in / 1 out costs $0.00006; Haiku at 100 in / 20 out, $0.0002, past the $0.0001 limit.
  const limited = setup([delegate("Find the config loader"), say("It's in config.ts.")]);
  const route = async () => ({ route: haiku });
  const events = await collect(
    limited.adapter,
    input({ route, maxConcurrent: 1, maxDepth: 1 }, { limits: { taskId: "task-1" as never, maxCost: 0.0001, spentUsd: 0, spentTurns: 0 } }),
  );
  expect(events).toContainEqual({
    type: "item",
    item: expect.objectContaining({
      kind: "tool.result",
      toolUseId: "toolu_d",
      isError: true,
      content: expect.stringContaining("cost limit"),
    }),
  });
  expect(events.at(-1)).toEqual({ type: "turn.finished", status: "limit", error: "Stopped at the task's $0.0001 cost limit." });
  expect(limited.fake.requests).toHaveLength(2);

  const { fake, adapter } = setup([delegate("Find the config loader"), { blocks: [{ type: "text", text: "Look" }], hang: true }]);
  const fiber = Effect.runFork(Stream.runCollect(adapter.run(input({ route, maxConcurrent: 1, maxDepth: 1 }))));
  await fake.arrived(2);
  await Effect.runPromise(Fiber.interrupt(fiber));
  expect(fake.requests[1]?.signal?.aborted).toBe(true);
});

test("with delegation off, a new session has no delegate_task", async () => {
  const { fake, adapter } = setup([say("Done.")]);
  await collect(adapter, input({ route: async () => ({ error: "unused" }), maxConcurrent: 3, maxDepth: 0 }));
  expect(toolNames(fake.requests[0]?.body)).not.toContain("delegate_task");
});
