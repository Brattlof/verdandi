import type Anthropic from "@anthropic-ai/sdk";
import type { HarnessRunInput, TurnId } from "@verdandi/contracts";
import { type Block, type Compression, type Entry, requestMessages } from "./transcript.ts";

/**
 * Context compression for a native session (DESIGN §16, ADR 0033). Past its trigger, a session first prunes: tool
 * results too big to keep go to disk, each with a stand-in pointing there. If that isn't enough, the conversation before
 * a recent tail is summarized: one message of a summary in fixed sections (an `aux.compress` task's, through
 * `summarize`), the exact identifiers the conversation mentioned and the user's own messages, verbatim, stands in for
 * it. The result is a `Compression` the transcript appends and requests are built from, so it's the session's one
 * cache break. Pure but for `prune`, which saves a result, and `summarize`.
 */

/** A rough token count of what a request sends: a quarter of its JSON's length. */
export const estimateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);

/**
 * The share of the window a session's prompt reaches before it compresses (DESIGN §16, ADR 0033): half of a window of
 * 512K tokens or more, and 80% of a smaller one, where replaying the recall exam's sessions at half compressed two or
 * three times for no better recall.
 */
export const compressAt = (window: number) => (window >= 512_000 ? 0.5 : 0.8);
/** Past this share of the window a compression that failed is tried again on each request. */
export const retryAt = 0.85;

/**
 * The verbatim tail a compression keeps: 12.5% of the window, clamped to 10K–25K tokens, so 25K on every window the
 * native harness runs today. On the recall exam a 25K tail held 9 points more of the answers than 10K (ADR 0033).
 */
export const tailBudget = (window: number) => Math.min(25_000, Math.max(10_000, Math.round(window * 0.125)));

/** A tool result longer than this many characters is pruned to disk once it's older than the tail. */
export const pruneOver = 8_000;

/** Saves a pruned tool result's whole text and says where, for its stand-in. */
export type Prune = (toolUseId: string, text: string) => string;

/** Writes a compression's summary sections: Verdandi's `aux.compress` task (`HarnessRunInput.summarize`), or a scripted one. */
export type Summarize = NonNullable<HarnessRunInput["summarize"]>;

/** A transcript block: what compression reads, carried blocks included, which say nothing to a summary. */
type Content = Block;

const textOf = (content: Anthropic.ToolResultBlockParam["content"]) =>
  typeof content === "string" ? content : (content ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");

/** Whether entry `i` can open a kept tail: a reply, or a user message with words of its own, not only tool results. */
const opens = (entry: Entry) =>
  entry.message.role === "assistant" || (entry.message.role === "user" && entry.message.content.some((b) => b.type !== "tool_result"));

/**
 * Where the tail starts: the earliest entry at or after `from` that can open one, with the entries from it on within
 * `budget` tokens; when even the newest can't fit, the newest that can open one, so the latest exchange always stays.
 */
export const tailStart = (entries: readonly Entry[], from: number, budget: number) => {
  let start: number | undefined;
  let last: number | undefined;
  let used = 0;
  for (let i = entries.length - 1; i >= from; i--) {
    const entry = entries[i] as Entry;
    used += estimateTokens(entry.message);
    if (last === undefined && opens(entry)) last = i;
    if (used > budget) break;
    if (opens(entry)) start = i;
  }
  return start ?? last ?? entries.length;
};

/** Verdandi's own blocks in a user message (memory, a handoff, a mode note, a reminder, a summary): not the user's words. */
const ours = (text: string) => text.startsWith("<verdandi-") || text.startsWith("Verdandi:");

/** The user's own words in `entries`, oldest first: each turn's message and each steer. */
export const userMessages = (entries: readonly Entry[]) =>
  entries.flatMap((e) =>
    e.message.role === "user" ? e.message.content.flatMap((b) => (b.type === "text" && !ours(b.text) ? [b.text.trim()] : [])) : [],
  );

/** Every string the entries say: the user's and agent's text, tool call inputs and tool results. */
const allText = (entries: readonly Entry[]) =>
  entries
    .flatMap((e) =>
      e.message.content.map((b: Content) =>
        b.type === "text" ? b.text : b.type === "tool_use" ? JSON.stringify(b.input) : b.type === "tool_result" ? textOf(b.content) : "",
      ),
    )
    .join("\n");

/** Exact identifiers worth keeping word for word, by kind, with how many of each the index lists at most. */
const anchorKinds: readonly [string, RegExp, number][] = [
  ["Issues and PRs", /(?<![\w&/])#\d{2,6}\b/g, 80],
  ["Commits", /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g, 40],
  ["Files", /(?:[A-Za-z]:)?[\w.@-]*(?:[\\/][\w.@-]+)+\.(?:ts|tsx|js|mjs|json|jsonl|md|yaml|yml|toml|sql|sh|py|rs|go|css|html)\b/g, 80],
  ["Errors", /\b(?:[A-Z][a-zA-Z]*(?:Error|Exception)|TS\d{4}|E[A-Z]{3,}|SIG[A-Z]{3,})\b[^\n]{0,80}/g, 40],
  ["URLs", /https?:\/\/[^\s)"'\]>`]{8,120}/g, 30],
];
const anchorBudget = 7_000;

/**
 * Pure: the exact identifiers `text` mentions (DESIGN §16's anchor index): issue and PR numbers, commits, paths, error
 * strings and URLs, the most frequent of each kind first, within a budget. No model reads them, so none is paraphrased.
 */
export const anchorIndex = (text: string) => {
  const lines: string[] = [];
  const anchors: string[] = [];
  let used = 0;
  for (const [kind, pattern, cap] of anchorKinds) {
    const counts = new Map<string, number>();
    for (const m of text.matchAll(pattern)) {
      const value = m[0].trim().replace(/[.,;:]+$/, "");
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const ranked = [...counts].sort((a, b) => b[1] - a[1]).slice(0, cap);
    if (ranked.length === 0) continue;
    const line = `${kind}: ${ranked.map(([v, n]) => (n > 1 ? `${v} (×${n})` : v)).join(", ")}`;
    if (used + line.length > anchorBudget) break;
    used += line.length;
    lines.push(line);
    anchors.push(...ranked.map(([v]) => v));
  }
  return { lines, anchors };
};

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max * 0.7)} […] ${text.slice(-max * 0.3)}`);

/** How much of the user's messages the summary quotes: each one up to `perMessage` characters, all within `budget`. */
const quoteBudget = { perMessage: 4_000, budget: 24_000 };

/** The user's messages quoted verbatim, oldest first: the first always, then the newest that fit. */
const quoted = (messages: readonly string[]) => {
  const clipped = messages.map((m) => clip(m, quoteBudget.perMessage));
  const keep = new Set<number>(clipped.length > 0 ? [0] : []);
  let used = clipped[0]?.length ?? 0;
  for (let i = clipped.length - 1; i > 0 && used + (clipped[i]?.length ?? 0) <= quoteBudget.budget; i--) {
    keep.add(i);
    used += clipped[i]?.length ?? 0;
  }
  const left = clipped.length - keep.size;
  return clipped.flatMap((m, i) => [
    ...(i === 1 && left > 0 ? [`[${left} earlier message${left === 1 ? "" : "s"} left out]`] : []),
    ...(keep.has(i) ? [`> ${m.replaceAll("\n", "\n> ")}`] : []),
  ]);
};

/** How long the digest a summary is written from gets: a lean input, since the identifiers and the user's words go verbatim anyway. */
const digestBudget = 120_000;

/**
 * Pure: the conversation being compressed as the summarizer reads it, each part clipped, tool results at their
 * stand-ins, and Verdandi's own blocks (memory, notes) left out.
 */
export const digestOf = (entries: readonly Entry[], pruned: Readonly<Record<string, string>>) => {
  const lines = entries.flatMap((e) =>
    e.message.content.flatMap((b: Content): string[] => {
      if (b.type === "text" && b.text.trim() !== "" && !ours(b.text))
        return [`${e.message.role === "user" ? "User" : "Agent"}: ${clip(b.text.trim(), e.message.role === "user" ? 4_000 : 1_500)}`];
      if (b.type === "tool_use") return [`Tool call ${b.name}: ${clip(JSON.stringify(b.input), 300)}`];
      if (b.type === "tool_result")
        return [`Tool result${b.is_error ? " (error)" : ""}: ${clip(pruned[b.tool_use_id] ?? textOf(b.content), 600)}`];
      return [];
    }),
  );
  // ponytail: past the budget the digest keeps its start and its end; sample evenly if the middle turns out to matter.
  return clip(lines.join("\n"), digestBudget);
};

/** The message that stands in for the compressed conversation. */
const summaryText = (block: string, anchors: readonly string[], users: readonly string[], messages: number) =>
  [
    "<verdandi-compression>",
    `Verdandi compressed the ${messages} messages before this point to keep the context small. Below: a summary of them in fixed sections, written by a small model; the exact identifiers they mention; and every message the user sent, verbatim, which outrank any paraphrase. Search the whole earlier conversation with session_search, and open a pruned tool result's file with read_file, rather than guess.`,
    block,
    "",
    "## Exact identifiers",
    ...(anchors.length > 0 ? anchors : ["None."]),
    "",
    "## User messages (verbatim, oldest first)",
    ...(users.length > 0 ? users : ["None."]),
    "</verdandi-compression>",
  ].join("\n");

/** What a compression did, for the turn's `compression` item; or why it wrote nothing. */
export type Compressed =
  | { readonly compression: Compression; readonly pruned: number; readonly summarized: boolean; readonly costUsd: number }
  | { readonly error: string };

/**
 * Compresses a session whose transcript holds `entries` and `compressions`, keeping a tail of `tail` tokens: prunes the
 * tool results older than the tail, then, if the request would still be over `summarizeOver` tokens, summarizes the
 * conversation before the tail. Fails closed: a summary missing a section (the summarizer's check) or an identifier of
 * the index (this one's) writes nothing. Undefined when there's nothing to do.
 */
export const compress = async (
  transcript: { readonly entries: readonly Entry[]; readonly compressions: readonly Compression[] },
  options: { readonly tail: number; readonly summarizeOver: number; readonly prune: Prune; readonly summarize?: Summarize | undefined },
): Promise<Compressed | undefined> => {
  const { entries } = transcript;
  const latest = transcript.compressions.at(-1);
  const kept = latest?.summary?.keepFrom ?? 0;
  const from = tailStart(entries, kept, options.tail);
  const names = new Map(
    entries.flatMap((e) =>
      e.message.role === "assistant" ? e.message.content.flatMap((b) => (b.type === "tool_use" ? [[b.id, b.name] as const] : [])) : [],
    ),
  );
  const pruned: Record<string, string> = { ...latest?.pruned };
  let count = 0;
  for (const e of entries.slice(kept, from))
    for (const b of e.message.role === "user" ? e.message.content : [])
      if (b.type === "tool_result" && pruned[b.tool_use_id] === undefined) {
        const text = textOf(b.content);
        if (text.length <= pruneOver) continue;
        const path = options.prune(b.tool_use_id, text);
        const name = names.get(b.tool_use_id) ?? "a tool";
        pruned[b.tool_use_id] =
          `[Verdandi moved this ${text.length.toLocaleString("en-US")}-character result of ${name} to ${path} to keep the context small; read_file opens it. It began: ${clip(text.slice(0, 400), 400)}]`;
        count++;
      }
  const prunedOnly: Compression = { at: entries.length, pruned, ...(latest?.summary && { summary: latest.summary }) };
  const after = estimateTokens(requestMessages(entries, true, prunedOnly));
  if (after <= options.summarizeOver || !options.summarize || from <= kept)
    return count === 0 ? undefined : { compression: prunedOnly, pruned: count, summarized: false, costUsd: 0 };
  const middle = entries.slice(kept, from);
  const written = await options.summarize({
    digest: digestOf(middle, pruned),
    ...(latest?.summary && { previous: latest.summary.sections }),
    turnIds: [...new Set(middle.map((e) => e.turnId as TurnId))],
  });
  if ("error" in written) return written;
  const before = entries.slice(0, from);
  const index = anchorIndex(allText(before));
  const text = summaryText(written.block, index.lines, quoted(userMessages(before)), from);
  const lost = index.anchors.filter((a) => !text.includes(a));
  if (lost.length > 0) return { error: `the summary lost ${lost.length} of the conversation's exact identifiers` };
  return {
    compression: { at: entries.length, pruned, summary: { keepFrom: from, text, sections: written.sections } },
    pruned: count,
    summarized: true,
    costUsd: written.costUsd,
  };
};
