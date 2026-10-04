import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { CompressionExam, ExamQuestion, ThreadId, TurnId } from "@verdandi/contracts";
import { Effect, Stream } from "effect";
import { makeNativeAdapter, maxTokens } from "./adapter.ts";
import { createTranscript, type Entry, type Prefix } from "./transcript.ts";

/**
 * The compression recall exam (#207, ADR 0033): long native transcripts, each with questions that have exact answers,
 * scored per compression policy by what the session's next request still holds. Offline (`bun test`, and the exam
 * runner's default) a policy's request is built on the fake provider and searched for each answer; the live run
 * (`apps/agent/src/compression/exam-run.ts`) has a model answer the questions from it.
 */

/** A session at the point it's compressed: its fixed prefix and its transcript's entries. */
export type ExamSession = { readonly prefix: Prefix; readonly entries: readonly Entry[] };

/** A compression policy under exam: the entries the session's next request is built from, in a window of `window` tokens. */
export type ExamPolicy = (session: ExamSession, window: number) => Entry[];

/** A rough token count of what a request sends: a quarter of its JSON's length. The live run counts with the API. */
export const estimateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);

/** The tail #186's research proposes: 2.5% of the window, clamped to 10K–25K tokens (Hermes's lean policy). */
export const tailBudget = (window: number) => Math.min(25_000, Math.max(10_000, Math.round(window * 0.025)));

const leftOut = "[Verdandi left out the conversation before this point to fit the context window.]";

/**
 * The newest entries within `budget` estimated tokens. They start at a turn's (or a steer's) message, its results
 * of earlier tool calls dropped, or at a reply, behind a note that the rest was left out, so the request still opens
 * with a user message. A tool call is never split from its result: a result always follows its call.
 */
export const keepNewest = (entries: readonly Entry[], budget: number): Entry[] => {
  let start: number | undefined;
  let used = estimateTokens(leftOut);
  for (let i = entries.length - 1; i >= 0; i--) {
    const { message } = entries[i] as Entry;
    used += estimateTokens(message);
    if (used > budget) break;
    if (message.role === "assistant" || (message.role === "user" && message.content.some((b) => b.type !== "tool_result"))) start = i;
  }
  const first = start === undefined ? undefined : entries[start];
  if (start === undefined || !first) return [];
  const content: Anthropic.ContentBlockParam[] =
    first.message.role === "assistant" ? [{ type: "text", text: leftOut }] : first.message.content.filter((b) => b.type !== "tool_result");
  const opening: Entry = { turnId: first.turnId, message: { role: "user", content } };
  return [opening, ...entries.slice(first.message.role === "assistant" ? start : start + 1)];
};

/** The policies the exam compares (#207's arms). #186's compressor joins them as `lean`. */
export const examPolicies: Record<string, ExamPolicy> = {
  /** No compression in a window that holds it all: the recall ceiling. */
  full: ({ entries }) => [...entries],
  /** No compression in a window too small for it: the newest entries that fit beside the prefix and the reply's room. */
  truncate: ({ prefix, entries }, window) => keepNewest(entries, window - maxTokens - estimateTokens(prefix)),
  /** A recency-only tail of #186's budget and nothing else: what a summary has to beat. */
  recency: ({ entries }, window) => keepNewest(entries, tailBudget(window)),
};

/** The fake provider as `nextRequest` uses it: `@verdandi/testkit`'s `makeFakeAnthropic`, scripted with one reply. */
type Capture = { readonly fetch: typeof globalThis.fetch; readonly requests: readonly { readonly body: Record<string, unknown> }[] };

/**
 * The request the session's next turn sends after a policy left `entries`: the native adapter resumes them from a
 * throwaway folder and runs a turn of `text` against `fake`, with every cache break thrown. What `fake` received last.
 */
export const nextRequest = async (session: ExamSession, entries: readonly Entry[], fake: Capture, text = "Go on.") => {
  const dir = mkdtempSync(join(tmpdir(), "verdandi exam "));
  try {
    const sessionsDir = join(dir, "native-sessions");
    const transcript = createTranscript(sessionsDir, "exam", session.prefix, entries);
    const adapter = makeNativeAdapter({
      apiKey: "sk-ant-exam",
      sessionsDir,
      reach: { home: dir, folders: [], readable: [] },
      terminal: { run: async () => ({ exitCode: 0, output: "", durationMs: 0 }), outputs: join(dir, "terminal-output") },
      fetch: fake.fetch,
      cacheBreaks: "throw",
    });
    await Effect.runPromise(
      Stream.runDrain(
        adapter.run({
          threadId: "exam" as ThreadId,
          turnId: "exam-next" as TurnId,
          cwd: dir,
          route: { harness: "native", model: "claude-sonnet-5-5", effort: "medium" },
          resumeSessionId: transcript.id,
          text,
          mode: "build",
          steers: Stream.empty,
        }),
      ),
    );
    const body = fake.requests.at(-1)?.body;
    if (!body) throw new Error("The native adapter sent no request.");
    return body as unknown as Anthropic.MessageCreateParams;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Slashes one way and whitespace runs as one space, so a Windows path or a wrapped error string still matches. */
const normalize = (text: string) => text.replaceAll("\\", "/").replace(/\s+/g, " ");

/** Every string the request's system prompt and messages send, tool call inputs included; never image data or signatures. */
export const requestText = (body: Pick<Anthropic.MessageCreateParams, "system" | "messages">) => {
  const out: string[] = [];
  const walk = (v: unknown, key = ""): void => {
    if (typeof v === "string") {
      if (key !== "data" && key !== "signature") out.push(v);
    } else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(body.system);
  walk(body.messages);
  return normalize(out.join("\n"));
};

/** The strings a question's answer rests on: an exact answer's spellings, or a judged one's evidence. */
const needles = (q: ExamQuestion) => (q.kind === "exact" ? [q.answer, ...(q.accept ?? [])] : q.evidence);

/** Whether `text` (normalized, as `requestText` returns it) holds any of `needles`. */
const holds = (text: string, strings: readonly string[]) => strings.some((s) => text.includes(normalize(s)));

/** Whether a reply gives an exact question's answer, in any spelling it accepts. */
export const answersExactly = (reply: string, q: Extract<ExamQuestion, { kind: "exact" }>) => holds(normalize(reply), needles(q));

/**
 * The offline score of one policy's request: its estimated tokens, and how many questions it still holds the answer
 * to (the mechanical parts of a compression: what it keeps verbatim). `missing` names the rest.
 */
export const offlineScore = (body: Anthropic.MessageCreateParams, exam: CompressionExam) => {
  const text = requestText(body);
  const missing = exam.questions.filter((q) => !holds(text, needles(q))).map((q) => q.id);
  return {
    tokens: estimateTokens({ system: body.system, tools: body.tools, messages: body.messages }),
    held: exam.questions.length - missing.length,
    questions: exam.questions.length,
    missing,
  };
};
