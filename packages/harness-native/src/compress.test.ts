import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { HarnessEvent, HarnessRunInput, HarnessTool, Route, ThreadId, TurnId } from "@verdandi/contracts";
import { type FakeReply, makeFakeAnthropic, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, Stream } from "effect";
import { makeNativeAdapter } from "./adapter.ts";
import { anchorIndex, type Summarize } from "./compress.ts";
import { createTranscript, type Entry, loadTranscript } from "./transcript.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) removeTempHome(h);
});

// Haiku's 200K window: compression triggers at 80% of it.
const haiku: Route = { harness: "native", model: "claude-haiku-4-5", effort: "low" };
const threadId = "thread-1" as ThreadId;
const lookup: HarnessTool = { name: "lookup", description: "Looks a thing up.", params: {}, call: async () => ({ text: "found it" }) };

/** A long session: `turns` turns, each a user message, a lookup call and a result of `size` characters, and a reply. */
const longSession = (turns: number, size: (k: number) => number = () => 7_500): Entry[] =>
  Array.from({ length: turns }, (_, k): Entry[] => {
    const turnId = `old-${k}`;
    return [
      { turnId, message: { role: "user", content: [{ type: "text", text: `Fix issue #${400 + k} in src/ledger${k}.ts.` }] } },
      {
        turnId,
        message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_old${k}`, name: "lookup", input: { q: `ledger ${k}` } }] },
      },
      {
        turnId,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: `toolu_old${k}`, content: `${"row ".repeat(size(k) / 4)}` }],
        },
      },
      { turnId, message: { role: "assistant", content: [{ type: "text", text: `Fixed src/ledger${k}.ts.` }] } },
    ];
  }).flat();

const setup = (script: readonly FakeReply[], entries: readonly Entry[]) => {
  const home = makeTempHome();
  homes.push(home);
  const sessionsDir = join(home, "native-sessions");
  createTranscript(
    sessionsDir,
    "session-1",
    {
      system: [{ type: "text", text: "You are a coding agent." }],
      tools: [{ name: "lookup", description: "Looks a thing up.", input_schema: { type: "object" } }],
    },
    entries,
  );
  const adapter = (fake: ReturnType<typeof makeFakeAnthropic>) =>
    makeNativeAdapter({
      apiKey: "sk-ant-test",
      sessionsDir,
      reach: { home, folders: [], readable: [] },
      terminal: { run: async () => ({ exitCode: 0, output: "", durationMs: 0 }), outputs: join(home, "terminal-output") },
      fetch: fake.fetch,
      cacheBreaks: "throw",
    });
  const fake = makeFakeAnthropic(script);
  return {
    home,
    sessionsDir,
    fake,
    adapter: adapter(fake),
    restart: (more: readonly FakeReply[]) => {
      const next = makeFakeAnthropic(more);
      return { fake: next, adapter: adapter(next) };
    },
  };
};

const input = (turnId: string, summarize?: Summarize): HarnessRunInput => ({
  threadId,
  cwd: "/work/ledger",
  route: haiku,
  resumeSessionId: "session-1",
  turnId: turnId as TurnId,
  text: "Carry on with the ledger.",
  mode: "build",
  steers: Stream.empty,
  tools: [lookup],
  ...(summarize && { summarize }),
});

const run = (adapter: ReturnType<typeof makeNativeAdapter>, turn: HarnessRunInput) =>
  Effect.runPromise(Stream.runCollect(adapter.run(turn))).then((events) => Array.from(events));

const messagesOf = (request: { body: Record<string, unknown> } | undefined) => (request?.body.messages ?? []) as Anthropic.MessageParam[];
const blocks = (m: Anthropic.MessageParam) => (Array.isArray(m.content) ? m.content : []);

/** Each tool call in the messages has its result in the next message, and each result follows its call. */
const pairsHold = (messages: readonly Anthropic.MessageParam[]) =>
  messages.every((m, i) => {
    const results = new Set(blocks(messages[i + 1] ?? m).flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : [])));
    const calls = new Set(blocks(messages[i - 1] ?? m).flatMap((b) => (b.type === "tool_use" ? [b.id] : [])));
    return blocks(m).every((b) => (b.type === "tool_use" ? results.has(b.id) : b.type === "tool_result" ? calls.has(b.tool_use_id) : true));
  });

/** A summarizer that writes fixed sections and records what it was asked. */
const scripted = () => {
  const asked: Parameters<Summarize>[0][] = [];
  const summarize: Summarize = async (request) => {
    asked.push(request);
    return { sections: "## Goal\nFix the ledger.", block: "## Goal\nFix the ledger.", costUsd: 0.02 };
  };
  return { asked, summarize };
};

test("a session past its trigger is compressed: the next request is smaller, keeps every tool call with its result, and a resume builds it again", async () => {
  const s = setup(
    [
      // Its prompt reaches 170K of Haiku's 200K: past the 80% trigger.
      { blocks: [{ type: "tool_use", id: "toolu_new", name: "lookup", input: { q: "totals" } }], usage: { input: 170_000 } },
      { blocks: [{ type: "text", text: "The ledger balances." }] },
    ],
    longSession(50),
  );
  const { asked, summarize } = scripted();
  const events = await run(s.adapter, input("turn-1", summarize));

  const [before, after] = s.fake.requests.map(messagesOf);
  expect(JSON.stringify(after).length).toBeLessThan(JSON.stringify(before).length / 2);
  // The summary's message leads, with the user's own words and the exact identifiers; the turn's own call stays.
  const lead = JSON.stringify(after?.[0]);
  expect(lead).toContain("<verdandi-compression>");
  expect(lead).toContain("## Goal\\nFix the ledger.");
  expect(lead).toContain("> Fix issue #400 in src/ledger0.ts.");
  expect(lead).toContain("src/ledger0.ts");
  expect(pairsHold(after ?? [])).toBe(true);
  expect(JSON.stringify(after?.slice(-2))).toContain("toolu_new");
  // What it summarized: the conversation before the tail, from the start.
  expect(asked).toHaveLength(1);
  expect(asked[0]?.digest).toContain("User: Fix issue #400 in src/ledger0.ts.");
  expect(asked[0]?.turnIds[0]).toBe("old-0" as TurnId);
  const item = events.find((e): e is Extract<HarnessEvent, { type: "item" }> => e.type === "item" && e.item.kind === "compression")?.item;
  expect(item).toMatchObject({ kind: "compression", tokensBefore: 170_000, pruned: 0, summarized: true, costUsd: 0.02 });

  // After a restart the session resumes from its transcript and builds the same messages, then the new turn's.
  const again = s.restart([{ blocks: [{ type: "text", text: "Still balanced." }] }]);
  await run(again.adapter, { ...input("turn-2"), text: "Check it again." });
  const resumed = messagesOf(again.fake.requests[0]);
  expect(resumed.slice(0, after?.length)).toEqual(after ?? []);
});

test("a summary that fails its check writes nothing: the turn goes on uncompressed, with a notice", async () => {
  const s = setup(
    [
      { blocks: [{ type: "tool_use", id: "toolu_new", name: "lookup", input: {} }], usage: { input: 170_000 } },
      { blocks: [{ type: "text", text: "Done." }] },
    ],
    longSession(50),
  );
  const events = await run(
    s.adapter,
    input("turn-1", async () => ({ error: "the summary left out Pending user asks" })),
  );

  expect(events).toContainEqual({ type: "item", item: { kind: "notice", text: expect.stringContaining("left out Pending user asks") } });
  expect(events.some((e) => e.type === "item" && e.item.kind === "compression")).toBe(false);
  expect(loadTranscript(s.sessionsDir, "session-1")?.compressions).toEqual([]);
  // The second request extends the first, so the cache holds (the check would have thrown otherwise).
  const [before, after] = s.fake.requests.map(messagesOf);
  expect(after?.slice(0, before?.length)).toEqual(before ?? []);
});

test("a session whose cache went cold prunes oversized old tool results to disk, with a stand-in naming the file", async () => {
  const s = setup(
    [{ blocks: [{ type: "text", text: "On it." }] }],
    longSession(20, (k) => (k === 0 ? 12_000 : 7_500)),
  );
  const events = await run(s.adapter, input("turn-1"));

  const result = blocks(messagesOf(s.fake.requests[0])[2] as Anthropic.MessageParam)[0] as Anthropic.ToolResultBlockParam;
  expect(String(result.content)).toStartWith("[Verdandi moved this 12,000-character result of lookup to ");
  const file = join(s.sessionsDir, "pruned", "session-1", "toolu_old0.txt");
  expect(String(result.content)).toContain(file);
  expect(existsSync(file) && readFileSync(file, "utf8").length).toBe(12_000);
  expect(events).toContainEqual({ type: "item", item: expect.objectContaining({ kind: "compression", pruned: 1, summarized: false }) });
});

test("the anchor index keeps issue numbers, commits, paths and error strings word for word", () => {
  const { anchors } = anchorIndex(
    "Merged #272 as 911360a; see packages/harness-native/src/adapter.ts. TypeError: x is not a function, then #272 again.",
  );
  expect(anchors).toEqual(
    expect.arrayContaining([
      "#272",
      "911360a",
      "packages/harness-native/src/adapter.ts",
      "TypeError: x is not a function, then #272 again",
    ]),
  );
});
