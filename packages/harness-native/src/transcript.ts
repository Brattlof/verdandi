import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { Effort } from "@verdandi/contracts";

/**
 * What a session sends ahead of its conversation, fixed for its life: the cache rule (ADR 0022). `deferred`: the MCP
 * tools the bridge's `tool_search` finds, which the request leaves out (DESIGN §9.4).
 */
export type Prefix = {
  readonly system: Anthropic.TextBlockParam[];
  readonly tools: (Anthropic.Tool | Anthropic.ToolSearchToolBm25_20251119)[];
  readonly deferred?: Anthropic.Tool[];
};

/**
/**
 * What a provider sent that only it reads back, carried unchanged in the transcript and sent back only to the
 * `provider` it came from (catalog `provider` id), e.g. a Chat Completions endpoint's `reasoning_details`.
 */
export type CarriedBlock = { readonly type: "carried"; readonly provider: string; readonly value: Record<string, unknown> };

/**
 * A session's normalized content blocks (DESIGN §9.5): text, image, tool use, tool result and thinking in the Messages
 * API's shapes, which v1 transcripts hold, plus carried ones. Each provider sends the blocks it can and drops the rest
 * (ADR 0035).
 */
export type Block = Anthropic.ContentBlockParam | CarriedBlock;

export type Message = { readonly role: "user" | "assistant"; readonly content: Block[] };

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
export type Entry = { readonly turnId: string; readonly message: Message | EffortMessage };

/** The effort the transcript's last effort message set, which holds from there on; undefined when there's none. */
export const saidEffort = (entries: readonly Entry[]) => {
  const said = entries.findLast((e) => e.message.role === "system")?.message;
  return said?.role === "system" ? said.output_config.effort : undefined;
};

/**
 * A compression of a session (DESIGN §16), which requests are built from once it's written. `at` is how many entries
 * the transcript had then. `pruned` maps each tool result moved to disk, by its call's id, to the text that stands in
 * for it, every earlier compression's included. With `summary`, the entries before `keepFrom` go, and one user message
 * of `text` stands in for them; `sections` is the model's part of it, which the next compression updates.
 */
export type Compression = {
  readonly at: number;
  readonly pruned: Readonly<Record<string, string>>;
  readonly summary?: { readonly keepFrom: number; readonly text: string; readonly sections: string };
};

/**
 * A native session's transcript on disk, `<dir>/<id>.jsonl`: a header line with the session's prefix, then one line
 * per message, and one per compression, appended and never rewritten, so thinking blocks go back exactly as the model
 * sent them, and a resume, or a revert to before a compression, builds the same requests.
 */
export type Transcript = {
  readonly id: string;
  readonly file: string;
  readonly prefix: Prefix;
  readonly entries: Entry[];
  readonly compressions: Compression[];
};

const fileOf = (dir: string, id: string) => join(dir, `${id}.jsonl`);

export const createTranscript = (
  dir: string,
  id: string,
  prefix: Prefix,
  entries: readonly Entry[] = [],
  compressions: readonly Compression[] = [],
): Transcript => {
  mkdirSync(dir, { recursive: true });
  const file = fileOf(dir, id);
  const lines = [{ v: 1, ...prefix }, ...entries, ...compressions.map((compression) => ({ compression }))];
  writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
  return { id, file, prefix, entries: [...entries], compressions: [...compressions] };
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
  const [header, ...rest] = parsed as [Prefix & { v: number }, ...(Entry | { readonly compression: Compression })[]];
  if (header?.v !== 1) throw new Error(`${file} doesn't start with a native session header.`);
  const entries = rest.filter((line): line is Entry => !("compression" in line));
  const compressions = rest.flatMap((line) => ("compression" in line ? [line.compression] : []));
  return {
    id,
    file,
    prefix: { system: header.system, tools: header.tools, ...(header.deferred && { deferred: header.deferred }) },
    entries,
    compressions,
  };
};

export const appendEntry = (transcript: Transcript, entry: Entry) => {
  appendFileSync(transcript.file, `${JSON.stringify(entry)}\n`);
  transcript.entries.push(entry);
};

/** Writes a compression: every later request of the session is built from it. */
export const appendCompression = (transcript: Transcript, compression: Compression) => {
  appendFileSync(transcript.file, `${JSON.stringify({ compression })}\n`);
  transcript.compressions.push(compression);
};

/** The compressions a copy of the transcript through `entries.length` entries keeps: a revert drops later ones. */
export const compressionsThrough = (transcript: Transcript, entries: number) => transcript.compressions.filter((c) => c.at <= entries);

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
/**
 * The messages a request sends, built from the transcript without changing it, with only the blocks `sends` keeps (a
 * provider's own, ADR 0035); a message left with none is skipped. A tool call an interrupt left without a result gets
 * one saying so, and user messages in a row (an interrupt before the reply) are joined, so user and assistant turns
 * alternate (DESIGN §9.4). The same transcript always builds the same messages, so the cache holds. Effort messages are
 * left out when `efforts` is false: a model without effort levels refuses them, and a Chat Completions endpoint takes
 * none.
 *
 * With a `compression` (the session's latest, DESIGN §16), each tool result it pruned is sent as its stand-in, and
 * with a summary the entries before its `keepFrom` go: the summary's message leads, then the latest effort message
 * before the cut, then the rest, less results of calls that were cut.
 */
export const requestMessages = (
  entries: readonly Entry[],
  efforts = true,
  compression?: Compression,
  sends: (block: Block) => boolean = () => true,
): (Message | EffortMessage)[] => {
  const out: ({ role: "user" | "assistant"; content: Block[] } | EffortMessage)[] = [];
  let open: string[] = [];
  const called = new Set<string>();
  const answer = (content: readonly Block[]) => {
    const answered = new Set(content.flatMap((b) => (b.type === "tool_result" ? [b.tool_use_id] : [])));
    const missing = open.filter((id) => !answered.has(id)).map(interrupted);
    open = [];
    return [...missing, ...content];
  };
  const pruned = compression?.pruned ?? {};
  const cut = compression?.summary;
  const before = cut ? entries.slice(0, cut.keepFrom) : [];
  const said = before.findLast((e) => e.message.role === "system");
  const kept: Entry[] = cut
    ? [
        { turnId: "", message: { role: "user", content: [{ type: "text", text: cut.text }] } },
        ...(said ? [said] : []),
        ...entries.slice(cut.keepFrom),
      ]
    : [...entries];
  for (const entry of kept) {
    const compressed =
      entry.message.role === "user" && compression
        ? {
            role: "user" as const,
            content: entry.message.content.flatMap((b): Block[] => {
              if (b.type !== "tool_result") return [b];
              if (!called.has(b.tool_use_id)) return [];
              const stand = pruned[b.tool_use_id];
              return [stand === undefined ? b : { ...b, content: stand }];
            }),
          }
        : entry.message;
    if (compressed.role === "assistant") for (const b of compressed.content) if (b.type === "tool_use") called.add(b.id);
    if (compressed.role === "system") {
      if (!efforts) continue;
      // A tool call left open gets its result before it, where the next user message would have put it.
      if (open.length > 0) out.push({ role: "user", content: answer([]) });
      out.push(compressed);
      continue;
    }
    const message = { role: compressed.role, content: compressed.content.filter(sends) };
    if (message.content.length === 0) continue;
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
