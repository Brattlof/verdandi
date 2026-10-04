import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { CompressionExam, ExamQuestion, ThreadId, TurnId } from "@verdandi/contracts";
import { Effect, Stream } from "effect";
import { makeNativeAdapter, maxTokens } from "./adapter.ts";
import { type Compressed, compress, estimateTokens, type Summarize, tailBudget } from "./compress.ts";
import { type Block, type Compression, createTranscript, type Entry, type Prefix, requestMessages } from "./transcript.ts";

/**
 * The compression recall exam (#207, ADR 0033): long native transcripts, each with questions that have exact answers,
 * scored per compression policy by what the session's next request still holds. Offline (`bun test`, and the exam
 * runner's default) a policy's request is built on the fake provider and searched for each answer; the live run
 * (`apps/agent/src/compression/exam-run.ts`) has a model answer the questions from it.
 */

/** A session at the point it's compressed: its fixed prefix and its transcript's entries. */
export type ExamSession = { readonly prefix: Prefix; readonly entries: readonly Entry[] };

/** What a policy leaves of a session: the transcript its next request is built from. */
export type Kept = { readonly entries: readonly Entry[]; readonly compressions?: readonly Compression[] };

/**
 * A compression policy under exam, in a window of `window` tokens. `summarize` writes a compression's sections: a
 * scripted one offline, so the score measures the mechanical parts, and the `aux.compress` prompt on a model live.
 */
export type ExamPolicy = (session: ExamSession, window: number, summarize: Summarize) => Kept | Promise<Kept>;

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
  const content: Block[] =
    first.message.role === "assistant" ? [{ type: "text", text: leftOut }] : first.message.content.filter((b) => b.type !== "tool_result");
  const opening: Entry = { turnId: first.turnId, message: { role: "user", content } };
  return [opening, ...entries.slice(first.message.role === "assistant" ? start : start + 1)];
};

/** A pruned result's file, in the exam: nothing is written, since the score reads only the request. */
const examPrune = (toolUseId: string) => `native-sessions/pruned/exam/${toolUseId}.txt`;

/** Every section headed and empty: what the summary adds offline, so the score is the mechanical parts'. */
export const scriptedSummary: Summarize = async () => {
  const block = ["Goal", "Constraints", "Progress", "Decisions", "Files touched", "Open issues", "Next steps", "Pending user asks"]
    .map((s) => `## ${s}\nNone.`)
    .join("\n\n");
  return { sections: block, block, costUsd: 0 };
};

/** The session compressed once, at its end, with a tail of `tail` tokens: #186's compressor, forced. */
const leanOnce = async ({ entries }: ExamSession, tail: number, summarize: Summarize): Promise<Kept> => {
  const done = await compress({ entries, compressions: [] }, { tail, summarizeOver: 0, prune: examPrune, summarize });
  if (done && "error" in done) throw new Error(`The compression failed: ${done.error}`);
  return { entries, compressions: done ? [done.compression] : [] };
};

/**
 * The session replayed as it grew, compressed each time its request passed `at` of the window, as the native harness
 * does (DESIGN §16): how often it breaks the cache, and what's left at the end.
 */
export const replay = async (session: ExamSession, window: number, at: number, tail: number, summarize: Summarize) => {
  const compressions: Compression[] = [];
  let times = 0;
  for (let n = 1; n <= session.entries.length; n++) {
    const entries = session.entries.slice(0, n);
    if (estimateTokens(requestMessages(entries, true, compressions.at(-1))) < at * window) continue;
    const done: Compressed | undefined = await compress(
      { entries, compressions },
      { tail, summarizeOver: (at * window) / 2, prune: examPrune, summarize },
    );
    if (!done) continue;
    if ("error" in done) throw new Error(`The compression failed: ${done.error}`);
    compressions.push(done.compression);
    times++;
  }
  return { kept: { entries: session.entries, compressions } satisfies Kept, times };
};

/**
 * The policy a name picks: an arm of the exam, `name@<tokens>` for a tail (or recency's budget) of that many tokens,
 * or undefined. `lean` is #186's compressor, compressing once at the session's end.
 */
export const examPolicy = (name: string): ExamPolicy | undefined => {
  const [arm, size] = name.split("@");
  const sized = size === undefined ? undefined : Number(size);
  if (sized !== undefined && !(Number.isInteger(sized) && sized > 0)) return undefined;
  const tail = (window: number) => sized ?? tailBudget(window);
  const arms: Record<string, ExamPolicy> = {
    /** No compression in a window that holds it all: the recall ceiling. */
    full: ({ entries }) => ({ entries }),
    /** No compression in a window too small for it: the newest entries that fit beside the prefix and the reply's room. */
    truncate: ({ prefix, entries }, window) => ({ entries: keepNewest(entries, window - maxTokens - estimateTokens(prefix)) }),
    /** A recency-only tail and nothing else: what a summary has to beat. */
    recency: ({ entries }, window) => ({ entries: keepNewest(entries, tail(window)) }),
    /** #186's compressor: prune, then summary, identifiers and the user's messages before a recent tail. */
    lean: (session, window, summarize) => leanOnce(session, tail(window), summarize),
  };
  return arms[arm ?? ""];
};

/** The fake provider as `nextRequest` uses it: `@verdandi/testkit`'s `makeFakeAnthropic`, scripted with one reply. */
type Capture = { readonly fetch: typeof globalThis.fetch; readonly requests: readonly { readonly body: Record<string, unknown> }[] };

/**
 * The request the session's next turn sends after a policy left `kept`: the native adapter resumes it from a
 * throwaway folder and runs a turn of `text` against `fake`, with every cache break thrown. What `fake` received last.
 */
export const nextRequest = async (session: ExamSession, kept: Kept, fake: Capture, text = "Go on.") => {
  const dir = mkdtempSync(join(tmpdir(), "verdandi exam "));
  try {
    const sessionsDir = join(dir, "native-sessions");
    const transcript = createTranscript(sessionsDir, "exam", session.prefix, kept.entries, kept.compressions);
    const adapter = makeNativeAdapter({
      apiKey: "sk-ant-exam",
      sessionsDir,
      reach: { home: dir, folders: [], readable: [] },
      terminal: { run: async () => ({ exitCode: 0, output: "", durationMs: 0 }), outputs: join(dir, "terminal-output") },
      fetch: fake.fetch,
      cacheBreaks: "throw",
      compress: false,
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
