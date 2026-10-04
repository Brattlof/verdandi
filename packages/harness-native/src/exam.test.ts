import { expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { CompressionExam } from "@verdandi/contracts";
import { makeFakeAnthropic } from "@verdandi/testkit";
import { maxTokens } from "./adapter.ts";
import { tailBudget } from "./compress.ts";
import { type ExamSession, examPolicy, keepNewest, nextRequest, offlineScore, scriptedSummary } from "./exam.ts";
import type { Entry } from "./transcript.ts";

/**
 * A small synthetic session: 20 turns, each the user's message naming an issue, a terminal call whose long output ends
 * in an error string, and the agent's reply naming the file it fixed. Turn 3 has a steer joined to its tool result.
 */
const syntheticSession = (): ExamSession => {
  const filler = "test output line, nothing to see here\n".repeat(160);
  const entries: Entry[] = [];
  for (let k = 0; k < 20; k++) {
    const turnId = `turn-${k}`;
    const say = (message: Entry["message"]) => entries.push({ turnId, message });
    say({ role: "user", content: [{ type: "text", text: `Fix issue #${300 + k} in the payments service.` }] });
    say({
      role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${k}`, name: "terminal", input: { command: `bun test src/mod${k}.test.ts` } }],
    });
    say({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `toolu_${k}`, content: `${filler}error: E${k}_LEDGER_MISMATCH at src/mod${k}.ts:${40 + k}` },
        ...(k === 3 ? [{ type: "text" as const, text: "Don't touch the migrations folder." }] : []),
      ],
    });
    say({ role: "assistant", content: [{ type: "text", text: `Fixed src/mod${k}.ts; the test passes now.` }] });
  }
  return {
    prefix: {
      system: [{ type: "text", text: "You are a coding agent in a synthetic exam session." }],
      tools: [{ name: "terminal", description: "Runs a shell command.", input_schema: { type: "object" } }],
    },
    entries,
  };
};

/** A judged question about the steer, and an exact one per turn's error string. */
const exam: CompressionExam = {
  transcript: "synthetic.jsonl",
  questions: [
    {
      id: "steer",
      kind: "judged" as const,
      question: "Which folder did the user say to leave alone?",
      answer: "The migrations folder.",
      evidence: ["Don't touch the migrations folder."],
    },
    ...Array.from({ length: 20 }, (_, k) => ({
      id: `error-${k}`,
      kind: "exact" as const,
      question: `Which error did the test for issue #${300 + k} fail with?`,
      answer: `E${k}_LEDGER_MISMATCH`,
    })),
  ],
};

/** Each tool call in a request with its result in the next message, and each result after its call. */
const pairsHold = (messages: readonly Anthropic.MessageParam[]) =>
  messages.every((m, i) => {
    const blocks = Array.isArray(m.content) ? m.content : [];
    const next = messages[i + 1];
    const results = new Set(
      (Array.isArray(next?.content) ? next.content : []).flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : [])),
    );
    const before = messages[i - 1];
    const calls = new Set((Array.isArray(before?.content) ? before.content : []).flatMap((b) => (b.type === "tool_use" ? [b.id] : [])));
    return blocks.every((b) => (b.type === "tool_use" ? results.has(b.id) : b.type === "tool_result" ? calls.has(b.tool_use_id) : true));
  });

const window = 80_000;

const score = async (policy: string) => {
  const session = syntheticSession();
  const fake = makeFakeAnthropic([{ blocks: [{ type: "text", text: "Going on." }] }]);
  const kept = await examPolicy(policy)?.(session, window, scriptedSummary);
  if (!kept) throw new Error(`No policy ${policy}.`);
  const body = await nextRequest(session, kept, fake);
  return { body, ...offlineScore(body, exam) };
};

test("the offline exam scores truncation against a recency-only tail on a synthetic session, through the fake provider", async () => {
  const full = await score("full");
  const truncate = await score("truncate");
  const recency = await score("recency");

  // A well-formed exam: the whole session holds every answer.
  expect(full.missing).toEqual([]);
  // Truncation fits the window beside the reply's room, and keeps more than the tail, so it holds more answers.
  expect(truncate.tokens).toBeLessThanOrEqual(window - maxTokens);
  expect(recency.tokens).toBeLessThan(truncate.tokens);
  expect(recency.tokens).toBeLessThanOrEqual(tailBudget(window) + 2_000);
  expect(truncate.held).toBeGreaterThan(recency.held);
  expect(recency.held).toBeGreaterThan(0);
  // What both kept is the newest: the last turn's error is there, the first's and the early steer aren't.
  for (const kept of [truncate, recency]) {
    expect(kept.missing).toContain("error-0");
    expect(kept.missing).toContain("steer");
    expect(kept.missing).not.toContain("error-19");
    expect(pairsHold(kept.body.messages)).toBe(true);
    expect(kept.body.messages[0]?.role).toBe("user");
  }
});

test("the compressor keeps what a recency tail of the same size loses: the user's words verbatim", async () => {
  const recency = await score("recency");
  const lean = await score("lean");

  expect(lean.missing).not.toContain("steer");
  expect(lean.held).toBeGreaterThan(recency.held);
  // A summary costs tokens, but far fewer than truncation keeps.
  expect(lean.tokens).toBeLessThan((await score("truncate")).tokens);
  expect(pairsHold(lean.body.messages)).toBe(true);
});

test("a cut inside a turn opens with a note, and one at a steer drops the results of calls it left out", () => {
  const { entries } = syntheticSession();
  // Turn 3's tool result with its steer, then the rest of the session.
  const atSteer = keepNewest(entries.slice(14), Number.POSITIVE_INFINITY);
  expect(atSteer[0]?.message.content).toEqual([{ type: "text", text: "Don't touch the migrations folder." }]);

  // From a reply's tool call on: it opens with a note, and its result follows it.
  const atReply = keepNewest(entries.slice(-3), Number.POSITIVE_INFINITY);
  expect(atReply.map((e) => e.message.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(JSON.stringify(atReply[0]?.message.content)).toContain("left out the conversation");

  expect(keepNewest(entries, 10)).toEqual([]);
});
