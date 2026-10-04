import { afterEach, expect, test } from "bun:test";
import type { CatalogEntry, HarnessEvent, HarnessRunInput, HarnessTool, McpServer, Route, ThreadId, TurnId } from "@verdandi/contracts";
import {
  type FakeChatReply,
  type FakeReply,
  fakeMcpServer,
  makeFakeAnthropic,
  makeFakeChatCompletions,
  makeTempHome,
  removeTempHome,
} from "@verdandi/testkit";
import { Effect, Stream } from "effect";
import { makeNativeAdapter } from "./adapter.ts";
import type { Endpoint } from "./chat-completions.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) removeTempHome(h);
});

const threadId = "thread-1" as ThreadId;
const model = (
  provider: string,
  name: string,
  access: CatalogEntry["access"],
  price = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
) =>
  ({
    harness: "native",
    provider,
    model: name,
    access,
    tier: "S",
    context: 32_768,
    vision: false,
    efforts: [],
    price,
  }) satisfies CatalogEntry;
const ollama: Endpoint = {
  id: "ollama",
  url: "http://127.0.0.1:11434/v1/",
  key: undefined,
  models: [model("ollama", "qwen3:8b", "local")],
};
const openrouter: Endpoint = {
  id: "openrouter",
  url: "https://openrouter.ai/api/v1",
  key: "or-test-key",
  models: [
    {
      ...model("openrouter", "qwen/qwen3-coder", "metered", { input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0.2 }),
      efforts: ["low", "high"],
    },
  ],
};
const local: Route = { harness: "native", model: "qwen3:8b", effort: "medium" };
const openrouterRoute: Route = { harness: "native", model: "qwen/qwen3-coder", effort: "high" };

/** Reads a file, without asking: a stand-in for the native file tools. */
const lookups: string[] = [];
const lookup: HarnessTool = {
  name: "lookup",
  description: "Looks a word up.",
  params: { word: { type: "string", description: "The word." } },
  call: async (args) => {
    lookups.push(String(args.word));
    return { text: `${String(args.word)}: a greeting.` };
  },
};

const setup = (endpoints: readonly Endpoint[], fetch: typeof globalThis.fetch, apiKey?: string) => {
  const home = makeTempHome();
  homes.push(home);
  return makeNativeAdapter({
    ...(apiKey !== undefined && { apiKey }),
    endpoints,
    sessionsDir: `${home}/native-sessions`,
    reach: { home, folders: [], readable: [] },
    terminal: { run: async () => ({ exitCode: 0, output: "", durationMs: 0 }), outputs: `${home}/terminal-output` },
    fetch,
    cacheBreaks: "throw",
  });
};

const input = (turnId: string, text: string, route: Route = local, resumeSessionId?: string): HarnessRunInput => ({
  threadId,
  cwd: "/work/site",
  route,
  resumeSessionId,
  turnId: turnId as TurnId,
  text,
  mode: "build",
  steers: Stream.empty,
  tools: [lookup],
});

/** The `n`th request (1-based) the fake endpoint got, its messages typed. */
const request = (fake: ReturnType<typeof makeFakeChatCompletions>, n: number) => {
  const r = fake.requests[n - 1];
  if (!r) throw new Error(`The fake endpoint got no request ${n}.`);
  return { ...r, messages: r.body.messages as Record<string, unknown>[] };
};

const run = (adapter: ReturnType<typeof makeNativeAdapter>, turn: HarnessRunInput) =>
  Effect.runPromise(Stream.runCollect(adapter.run(turn))).then((events) => Array.from(events) as HarnessEvent[]);
/** Runs a turn to its exit, denying each `provider.failed` as Verdandi does when it finds no fallback; collects those. */
const failure = async (adapter: ReturnType<typeof makeNativeAdapter>, turn: HarnessRunInput) => {
  const failed: HarnessEvent[] = [];
  const exit = await Effect.runPromise(
    Effect.exit(
      Stream.runCollect(
        Stream.tap(adapter.run(turn), (e) =>
          e.type === "provider.failed"
            ? Effect.andThen(
                Effect.sync(() => failed.push(e)),
                adapter.respond(threadId, e.requestId, { decision: "deny" }),
              )
            : Effect.void,
        ),
      ),
    ),
  );
  return { failed, error: JSON.stringify(exit) };
};

test("a native turn on a local model calls a tool, carries the endpoint's reasoning back, and is priced as local", async () => {
  const fake = makeFakeChatCompletions([
    { reasoning: "They want a word.", text: "Looking it up.", toolCalls: [{ id: "call_1", name: "lookup", input: { word: "hej" } }] },
    { text: "Hej means hello.", usage: { prompt: 300, completion: 12, cached: 250 } },
  ]);
  const adapter = setup([ollama], fake.fetch);
  const events = await run(adapter, input("t1", "What's hej?"));

  expect(lookups).toContain("hej");
  expect(events).toContainEqual({
    type: "item",
    item: { kind: "tool.result", toolUseId: "call_1", isError: false, content: "hej: a greeting." },
  });
  expect(events.at(-1)).toEqual({ type: "turn.finished", status: "success" });
  const usage = events.filter((e) => e.type === "usage");
  expect(usage).toHaveLength(2);
  for (const u of usage) expect(u).toMatchObject({ model: "qwen3:8b", accessMode: "local", costUsd: 0 });
  expect(usage[1]).toMatchObject({ inputTokens: 50, cacheReadTokens: 250, outputTokens: 12 });
  expect(adapter.catalog?.map((e) => e.model)).toEqual(["qwen3:8b"]);

  const [a, b] = [request(fake, 1), request(fake, 2)];
  expect(a.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
  expect(a.headers.authorization).toBeUndefined();
  // The cache rule holds on this provider too: the same system message and tools, and the conversation only grows.
  expect(JSON.stringify([b.body.tools, b.messages[0]])).toBe(JSON.stringify([a.body.tools, a.messages[0]]));
  expect((a.body.tools as { function: { name: string } }[]).map((t) => t.function.name)).toContain("lookup");
  expect(a.body.reasoning_effort).toBeUndefined();
  expect(b.messages.slice(2)).toEqual([
    {
      role: "assistant",
      content: "Looking it up.",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"word":"hej"}' } }],
      reasoning: "They want a word.",
    },
    { role: "tool", tool_call_id: "call_1", content: "hej: a greeting." },
  ]);
});

test("a metered endpoint gets its key, the route's effort, and its reasoning_details back whole after streaming in pieces", async () => {
  const pieces = [
    { type: "reasoning.text", text: "Let ", index: 0, format: "anthropic-claude-v1" },
    { type: "reasoning.text", text: "me look", index: 0 },
    { type: "reasoning.text", signature: "sig-1", index: 0 },
  ];
  const fake = makeFakeChatCompletions([
    {
      reasoningDetails: pieces,
      toolCalls: [{ id: "call_1", name: "lookup", input: { word: "tack" } }],
      usage: { prompt: 1000, completion: 100 },
    },
    { text: "Thanks." },
  ]);
  const adapter = setup([openrouter], fake.fetch);
  const events = await run(adapter, input("t1", "tack?", openrouterRoute));

  const [first] = events.filter((e) => e.type === "usage");
  expect(first).toMatchObject({ accessMode: "metered", costUsd: (1000 * 0.2 + 100 * 0.8) / 1e6 });
  const [a, b] = [request(fake, 1), request(fake, 2)];
  expect(a.headers.authorization).toBe("Bearer or-test-key");
  expect(a.body.reasoning_effort).toBe("high");
  expect(b.messages[2]?.reasoning_details).toEqual([
    { type: "reasoning.text", text: "Let me look", index: 0, format: "anthropic-claude-v1", signature: "sig-1" },
  ]);
  expect(JSON.stringify(events)).not.toContain("or-test-key");
});

test("one session moves between providers, each sent only the blocks it can read back", async () => {
  const chat = makeFakeChatCompletions([{ reasoning: "Local thought.", text: "Local answer." }, { text: "Local again." }]);
  const anthropic = makeFakeAnthropic([
    {
      blocks: [
        { type: "thinking", thinking: "", signature: "sig-a" },
        { type: "text", text: "Sonnet answer." },
      ],
    } satisfies FakeReply,
  ]);
  // One fetch for both, routed by host, as verdandid's one process would be.
  const fetch = ((url: string | URL | Request, init?: RequestInit) =>
    String(url).startsWith("https://api.anthropic.com") ? anthropic.fetch(url, init) : chat.fetch(url, init)) as typeof globalThis.fetch;
  const adapter = setup([ollama], fetch, "sk-ant-test");
  const sonnet: Route = { harness: "native", model: "claude-sonnet-5-5", effort: "medium" };

  const started = (await run(adapter, input("t1", "one"))).find((e) => e.type === "session.started");
  const session = started?.type === "session.started" ? started.sessionId : undefined;
  await run(adapter, input("t2", "two", sonnet, session));
  await run(adapter, input("t3", "three", local, session));

  // Anthropic never sees the endpoint's carried reasoning; the endpoint never sees Anthropic's thinking block.
  const toAnthropic = JSON.stringify(anthropic.requests[0]?.body.messages);
  expect(toAnthropic).toContain("Local answer.");
  expect(toAnthropic).not.toContain("Local thought.");
  expect(toAnthropic).not.toContain("carried");
  const toChat = JSON.stringify(chat.requests[1]?.body.messages);
  expect(toChat).toContain("Sonnet answer.");
  expect(toChat).toContain("Local thought.");
  expect(toChat).not.toContain("sig-a");
  expect(adapter.catalog?.map((e) => e.provider)).toContain("anthropic");
});

test("an endpoint that rate-limits is retried; one still failing reports a provider failure, and one that's down names the fix", async () => {
  const replies: FakeChatReply[] = [{ error: { status: 429, message: "slow down", retryAfter: 0 } }, { text: "Fine." }];
  const retried = makeFakeChatCompletions(replies);
  const ok = await run(setup([ollama], retried.fetch), input("t1", "hi"));
  expect(ok.at(-1)).toEqual({ type: "turn.finished", status: "success" });
  expect(retried.requests).toHaveLength(2);

  // Past its retries, a rate limit is the model's, until the endpoint's retry-after.
  const limited = makeFakeChatCompletions([1, 2, 3].map(() => ({ error: { status: 429, message: "slow down", retryAfter: 0 } })));
  const busy = await failure(setup([openrouter], limited.fetch), input("t1", "hi", openrouterRoute));
  expect(limited.requests).toHaveLength(3);
  expect(busy.failed).toEqual([
    {
      type: "provider.failed",
      requestId: expect.any(String),
      provider: "openrouter",
      model: "qwen/qwen3-coder",
      reason: "rate_limit",
      until: expect.any(String),
      reset: true,
      error: "429 slow down",
    },
  ]);
  expect(busy.error).toContain("openrouter is rate-limiting qwen/qwen3-coder until");

  const missing = makeFakeChatCompletions([{ error: { status: 404, message: 'model "qwen3:8b" not found' } }]);
  const notFound = await failure(setup([ollama], missing.fetch), input("t1", "hi"));
  expect(notFound.failed).toMatchObject([{ provider: "ollama", model: "qwen3:8b", reason: "model_not_found", reset: false }]);
  expect(notFound.error).toContain("ollama doesn't serve qwen3:8b");
  expect(notFound.error).toContain("ollama pull");

  const rejected = makeFakeChatCompletions([{ error: { status: 401, message: "bad key" } }]);
  const auth = await failure(setup([openrouter], rejected.fetch), input("t1", "hi", openrouterRoute));
  expect(auth.failed).toMatchObject([{ provider: "openrouter", reason: "auth" }]);
  expect(auth.error).toContain("verdandi key set openrouter");
  expect(auth.error).not.toContain("or-test-key");

  const down = (async () => {
    throw new TypeError("Unable to connect");
  }) as unknown as typeof globalThis.fetch;
  const unreachable = await failure(setup([ollama], down), input("t1", "hi"));
  expect(unreachable.failed).toEqual([]);
  expect(unreachable.error).toContain("Couldn't reach ollama (http://127.0.0.1:11434/v1/)");
  expect((await failure(setup([ollama], down), input("t1", "hi", { ...local, model: "claude-sonnet-5-5" }))).error).toContain(
    "doesn't run claude-sonnet-5-5. Pick one of qwen3:8b",
  );
});

/** The fake MCP server with `extra` more tools: 3 + 10 is enough to defer them (DESIGN §9.4). */
const mcpServers = async () => ({
  servers: [
    {
      name: "fake",
      command: process.execPath,
      args: [fakeMcpServer],
      env: {
        ...Object.fromEntries(Object.entries(process.env).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]]))),
        FAKE_MCP_TOOLS: "10",
      },
      ask: true,
      tools: {},
    } satisfies McpServer,
  ],
  notices: [],
});
const screened = async (text: string) => `[screened] ${text}`;
/** A turn in a real folder, with the MCP servers and the reactor's screen, allowing every approval it asks for. */
const mcpTurn = (adapter: ReturnType<typeof makeNativeAdapter>, turn: HarnessRunInput) => {
  const cwd = makeTempHome();
  homes.push(cwd);
  return Effect.runPromise(
    Stream.runCollect(
      Stream.tap(adapter.run({ ...turn, cwd, mcp: mcpServers, screen: screened }), (e) =>
        e.type === "approval.requested" ? adapter.respond(threadId, e.requestId, { decision: "allow" }) : Effect.void,
      ),
    ),
  ).then((events) => Array.from(events) as HarnessEvent[]);
};
const toolNames = (body: Record<string, unknown> | undefined) =>
  ((body?.tools ?? []) as { name?: string; function?: { name: string } }[]).map((t) => t.function?.name ?? t.name ?? "");
const sessionOf = (events: readonly HarnessEvent[]) => {
  const started = events.find((e) => e.type === "session.started");
  return started?.type === "session.started" ? started.sessionId : undefined;
};

test("a session that opens on an endpoint takes the bridge for many MCP tools, and keeps it on the Anthropic API", async () => {
  const chat = makeFakeChatCompletions([
    { toolCalls: [{ id: "call_1", name: "tool_search", input: { query: "number 7" } }] },
    { toolCalls: [{ id: "call_2", name: "tool_call", input: { name: "mcp__fake__tool_7", arguments: { text: "hi" } } }] },
    { text: "Done." },
  ]);
  const anthropic = makeFakeAnthropic([
    { blocks: [{ type: "tool_use", id: "toolu_1", name: "tool_call", input: { name: "mcp__fake__tool_3", arguments: { text: "yo" } } }] },
    { blocks: [{ type: "text", text: "Done there too." }] },
  ]);
  const fetch = ((url: string | URL | Request, init?: RequestInit) =>
    String(url).startsWith("https://api.anthropic.com") ? anthropic.fetch(url, init) : chat.fetch(url, init)) as typeof globalThis.fetch;
  const adapter = setup([ollama], fetch, "sk-ant-test");

  const local = await mcpTurn(adapter, input("t1", "Use tool 7"));
  // The deferred tools stay out of the request; the bridge's three stand in for them.
  const [first] = chat.requests.map((r) => r.body);
  expect(toolNames(first)).toContain("tool_call");
  expect(toolNames(first).filter((n) => n.startsWith("mcp__"))).toEqual([]);
  expect(JSON.stringify(first)).not.toContain("defer_loading");
  // tool_call runs the real tool, by its name, through its approval.
  expect(local).toContainEqual({
    type: "item",
    item: { kind: "tool.call", toolUseId: "call_2", name: "mcp__fake__tool_7", input: { text: "hi" } },
  });
  expect(local.filter((e) => e.type === "approval.requested").map((e) => e.type === "approval.requested" && e.toolName)).toEqual([
    "mcp__fake__tool_7",
  ]);
  expect(local).toContainEqual({
    type: "item",
    item: { kind: "tool.result", toolUseId: "call_2", isError: false, content: "[screened] tool_7" },
  });

  // The same session on the Anthropic API: the bridge's tools are ordinary ones, so its tool_call works there too.
  const sonnet: Route = { harness: "native", model: "claude-sonnet-5-5", effort: "medium" };
  const moved = await mcpTurn(adapter, input("t2", "Now tool 3", sonnet, sessionOf(local)));
  const toAnthropic = anthropic.requests[0]?.body;
  expect(toolNames(toAnthropic)).toContain("tool_call");
  expect(toolNames(toAnthropic)).not.toContain("tool_search_tool_bm25");
  expect(JSON.stringify(toAnthropic)).not.toContain("defer_loading");
  expect(moved).toContainEqual({
    type: "item",
    item: { kind: "tool.result", toolUseId: "toolu_1", isError: false, content: "[screened] tool_3" },
  });
  expect(moved.at(-1)).toEqual({ type: "turn.finished", status: "success" });
  await Effect.runPromise(adapter.close());
});

test("a session that opened on the API's server tool search, moved onto an endpoint, sends its deferred tools in full and none of the search's blocks", async () => {
  const anthropic = makeFakeAnthropic([
    {
      blocks: [
        {
          type: "server",
          block: { type: "server_tool_use", id: "srvtoolu_1", name: "tool_search_tool_bm25", input: { query: "number 7" } },
        },
        {
          type: "server",
          block: {
            type: "tool_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: {
              type: "tool_search_tool_search_result",
              tool_references: [{ type: "tool_reference", tool_name: "mcp__fake__tool_7" }],
            },
          },
        },
        { type: "text", text: "There's a tool_7." },
      ],
    },
  ]);
  const chat = makeFakeChatCompletions([
    { toolCalls: [{ id: "call_1", name: "mcp__fake__tool_7", input: { text: "hi" } }] },
    { text: "Done." },
  ]);
  const fetch = ((url: string | URL | Request, init?: RequestInit) =>
    String(url).startsWith("https://api.anthropic.com") ? anthropic.fetch(url, init) : chat.fetch(url, init)) as typeof globalThis.fetch;
  const adapter = setup([ollama], fetch, "sk-ant-test");
  const sonnet: Route = { harness: "native", model: "claude-sonnet-5-5", effort: "medium" };

  const opened = await mcpTurn(adapter, input("t1", "Find tool 7", sonnet));
  expect(toolNames(anthropic.requests[0]?.body)).toContain("tool_search_tool_bm25");
  // Two requests on the endpoint: the cache check (which throws in tests) holds between them.
  const moved = await mcpTurn(adapter, input("t2", "Use it", local, sessionOf(opened)));
  const [a, b] = chat.requests.map((r) => r.body);
  expect(toolNames(a)).not.toContain("tool_search_tool_bm25");
  expect(toolNames(a)).toContain("mcp__fake__tool_7");
  expect(JSON.stringify(a)).not.toContain("defer_loading");
  expect(JSON.stringify(b?.messages)).toContain("There's a tool_7.");
  expect(JSON.stringify(b?.messages)).not.toContain("srvtoolu_1");
  expect(JSON.stringify(b?.tools)).toBe(JSON.stringify(a?.tools));
  expect(moved).toContainEqual({
    type: "item",
    item: { kind: "tool.result", toolUseId: "call_1", isError: false, content: "[screened] tool_7" },
  });
  await Effect.runPromise(adapter.close());
});
