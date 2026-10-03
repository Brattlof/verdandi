import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "@verdandi/contracts";

/** What a session sends ahead of its conversation, fixed for its life: the cache rule (ADR 0022). */
export type Prefix = { readonly system: Anthropic.TextBlockParam[]; readonly tools: Anthropic.Tool[] };

/**
 * An effort-only system message (beta `mid-conversation-output-config-2026-07-01`, ADR 0022): the effort from the next
 * user message on, until another one changes it, without the cache miss a top-level effort change costs (DESIGN §8.7).
 */
export type EffortMessage = {
  readonly role: "system";
  readonly content: Anthropic.ContentBlockParam[];
  readonly output_config: { readonly effort: Effort };
};

/** One message of a session, tagged with the Verdandi turn it belongs to, so a revert can fork after any turn. */
export type Entry = {
  readonly turnId: string;
  readonly message: { readonly role: "user" | "assistant"; readonly content: Anthropic.ContentBlockParam[] } | EffortMessage;
};

/** The effort the transcript's last effort message set, which holds from there on; undefined when there's none. */
export const saidEffort = (entries: readonly Entry[]) => {
  const said = entries.findLast((e) => e.message.role === "system")?.message;
  return said?.role === "system" ? said.output_config.effort : undefined;
};

/**
 * A native session's transcript on disk, `<dir>/<id>.jsonl`: a header line with the session's prefix, then one line
 * per message, appended and never rewritten, so thinking blocks go back exactly as the model sent them.
 */
export type Transcript = { readonly id: string; readonly file: string; readonly prefix: Prefix; readonly entries: Entry[] };

const fileOf = (dir: string, id: string) => join(dir, `${id}.jsonl`);

export const createTranscript = (dir: string, id: string, prefix: Prefix, entries: readonly Entry[] = []): Transcript => {
  mkdirSync(dir, { recursive: true });
  const file = fileOf(dir, id);
  writeFileSync(file, [{ v: 1, ...prefix }, ...entries].map((line) => `${JSON.stringify(line)}\n`).join(""));
  return { id, file, prefix, entries: [...entries] };
};

/**
 * Reads a session back, or undefined when its file is gone. A last line cut short (verdandid stopped mid-write) is
 * dropped; anything else unreadable throws.
 */
export const loadTranscript = (dir: string, id: string): Transcript | undefined => {
  const file = fileOf(dir, id);
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const parsed: unknown[] = [];
  lines.forEach((line, i) => {
    try {
      parsed.push(JSON.parse(line));
    } catch (e) {
      if (i < lines.length - 1) throw new Error(`${file} line ${i + 1} isn't JSON (${e instanceof Error ? e.message : String(e)}).`);
    }
  });
  const [header, ...entries] = parsed as [Prefix & { v: number }, ...Entry[]];
  if (header?.v !== 1) throw new Error(`${file} doesn't start with a native session header.`);
  return { id, file, prefix: { system: header.system, tools: header.tools }, entries };
};

export const appendEntry = (transcript: Transcript, entry: Entry) => {
  appendFileSync(transcript.file, `${JSON.stringify(entry)}\n`);
  transcript.entries.push(entry);
};

/** The entries up to the end of turn `turnId`, or undefined when the transcript doesn't have that turn. */
export const entriesThrough = (transcript: Transcript, turnId: string) => {
  const last = transcript.entries.findLastIndex((e) => e.turnId === turnId);
  return last < 0 ? undefined : transcript.entries.slice(0, last + 1);
};

const interrupted = (id: string): Anthropic.ToolResultBlockParam => ({
  type: "tool_result",
  tool_use_id: id,
  is_error: true,
  content: "The user interrupted the turn before this tool ran.",
});

/**
 * The messages a request sends, built from the transcript without changing it. A tool call an interrupt left without
 * a result gets one saying so, and user messages in a row (an interrupt before the reply) are joined, so user and
 * assistant turns alternate (DESIGN §9.4). The same transcript always builds the same messages, so the cache holds.
 * Effort messages are left out for a model without effort levels (`efforts` false), which refuses them.
 */
export const requestMessages = (entries: readonly Entry[], efforts = true): Anthropic.MessageParam[] => {
  const out: ({ role: "user" | "assistant"; content: Anthropic.ContentBlockParam[] } | EffortMessage)[] = [];
  let open: string[] = [];
  const answer = (content: readonly Anthropic.ContentBlockParam[]) => {
    const answered = new Set(content.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : [])));
    const missing = open.filter((id) => !answered.has(id)).map(interrupted);
    open = [];
    return [...missing, ...content];
  };
  for (const { message } of entries) {
    if (message.role === "system") {
      if (!efforts) continue;
      // A tool call left open gets its result before it, where the next user message would have put it.
      if (open.length > 0) out.push({ role: "user", content: answer([]) });
      out.push(message);
      continue;
    }
    if (message.role === "user") {
      const content = answer(message.content);
      const last = out.at(-1);
      if (last?.role === "user") last.content = [...last.content, ...content];
      else out.push({ role: "user", content });
      continue;
    }
    if (open.length > 0) out.push({ role: "user", content: answer([]) });
    out.push({ role: "assistant", content: message.content });
    open = message.content.flatMap((b) => (b.type === "tool_use" ? [b.id] : []));
  }
  if (open.length > 0) out.push({ role: "user", content: answer([]) });
  return out;
};
