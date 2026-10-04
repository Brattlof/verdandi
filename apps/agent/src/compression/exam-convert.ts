// Turns Claude Code session transcripts into native transcripts for the compression recall exam (#207, ADR 0033),
// with secrets masked by the trajectories redactor. The exam's transcripts stay out of the repo, in the gitignored
// evals/compression/private/ (the default --out); read what this writes before you write questions about it.
//   bun apps/agent/src/compression/exam-convert.ts <session.jsonl>... [--out <dir>]
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createTranscript, type Entry, type Prefix } from "@verdandi/harness-native";
import { redact } from "@verdandi/trajectories";

/** One line of a Claude Code transcript, as far as the conversion reads it. */
type Line = {
  readonly type?: string;
  readonly isSidechain?: boolean;
  readonly isMeta?: boolean;
  readonly message?: { readonly role?: string; readonly content?: unknown };
  readonly attachment?: { readonly type?: string; readonly prompt?: unknown };
};

type Block = Record<string, unknown> & { readonly type?: string };

/** A content block of a native transcript's message. */
type Content = Entry["message"]["content"][number];

const blocksOf = (content: unknown): Block[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Block[]) : [];

/** A tool result's content as text: images and tool references named, not carried. */
const resultText = (content: unknown) =>
  blocksOf(content)
    .map((b) =>
      b.type === "text"
        ? String(b.text)
        : b.type === "image"
          ? "[image]"
          : b.type === "tool_reference"
            ? `[tool ${String(b.tool_name)}]`
            : "",
    )
    .filter((t) => t !== "")
    .join("\n");

/**
 * Pure: a Claude Code session as a native transcript's entries. Each real user message starts a turn; a message
 * queued while the agent worked joins the next user message, as a native steer does. Thinking is left out (its
 * signatures belong to Claude Code's requests), images become `[image]`, harness-made meta messages and subagents' lines
 * go, and a tool result is kept once. One that arrives after the agent moved on (a background task's) becomes text,
 * since the API takes a result only right after its call. The prefix's tools are the ones the session called, with open schemas.
 */
export const fromClaudeCode = (text: string): { readonly prefix: Prefix; readonly entries: Entry[] } => {
  const lines = text.split("\n").flatMap((l): Line[] => {
    try {
      return l.trim() === "" ? [] : [JSON.parse(l) as Line];
    } catch {
      return [];
    }
  });
  const entries: Entry[] = [];
  const calls = new Map<string, string>();
  const answered = new Set<string>();
  /** The calls of the latest reply still waiting for their results. */
  let open = new Set<string>();
  let turn = 0;
  const add = (role: "user" | "assistant", content: Content[], newTurn = false) => {
    if (content.length === 0) return;
    if (newTurn) turn++;
    const last = entries.at(-1);
    // Before the first real user message there's no conversation yet.
    if (turn === 0) return;
    const turnId = `turn-${turn}`;
    if (last && last.turnId === turnId && last.message.role === role) last.message.content.push(...content);
    else entries.push({ turnId, message: { role, content } });
  };
  for (const line of lines) {
    if (line.type === "attachment" && line.attachment?.type === "queued_command") {
      const prompt = resultText(line.attachment.prompt);
      if (prompt !== "") add("user", [{ type: "text", text: prompt }]);
      continue;
    }
    if (line.isSidechain || line.isMeta || (line.type !== "user" && line.type !== "assistant")) continue;
    const blocks = blocksOf(line.message?.content);
    if (line.type === "assistant") {
      const said = blocks.flatMap((b): Content[] => {
        if (b.type === "text" && String(b.text).trim() !== "") return [{ type: "text", text: String(b.text) }];
        if (b.type !== "tool_use" || calls.has(String(b.id))) return [];
        calls.set(String(b.id), String(b.name));
        return [{ type: "tool_use", id: String(b.id), name: String(b.name), input: b.input ?? {} }];
      });
      if (said.length > 0 && entries.at(-1)?.message.role !== "assistant") open = new Set();
      for (const b of said) if (b.type === "tool_use") open.add(b.id);
      add("assistant", said);
      continue;
    }
    const results = blocks.flatMap((b): Content[] => {
      const id = String(b.tool_use_id);
      if (b.type !== "tool_result" || !calls.has(id) || answered.has(id)) return [];
      answered.add(id);
      const content = resultText(b.content);
      if (open.delete(id)) return [{ type: "tool_result", tool_use_id: id, content, ...(b.is_error === true && { is_error: true }) }];
      return [
        {
          type: "text",
          text: `The result of the earlier ${calls.get(id)} call ${id}:
${content}`,
        },
      ];
    });
    const said = blocks.flatMap((b): Content[] =>
      b.type === "text" ? [{ type: "text", text: String(b.text) }] : b.type === "image" ? [{ type: "text", text: "[image]" }] : [],
    );
    if (results.length > 0) add("user", [...results, ...said]);
    else if (said.length > 0) {
      // A new turn: calls still open were cut off (the native transcript answers them as interrupted).
      open = new Set();
      add("user", said, true);
    }
  }
  // The conversation opens with a user message.
  while (entries[0]?.message.role === "assistant") entries.shift();
  const prefix: Prefix = {
    system: [
      {
        type: "text",
        text: "A coding session between a user and Claude Code, converted from Claude Code's transcript for Verdandi's compression recall exam.",
      },
    ],
    tools: [...new Set(calls.values())].sort().map((name) => ({
      name,
      description: `Claude Code's ${name} tool, as the session called it.`,
      input_schema: { type: "object" as const },
    })),
  };
  return { prefix: redact(prefix), entries: redact(entries) };
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--out");
  const out = at >= 0 ? args[at + 1] : join(import.meta.dir, "../../../../evals/compression/private");
  const files = args.filter((_, i) => i !== at && i !== at + 1);
  if (!out || files.length === 0) {
    console.error("Usage: bun apps/agent/src/compression/exam-convert.ts <session.jsonl>... [--out <dir>]");
    process.exit(2);
  }
  for (const file of files) {
    const { prefix, entries } = fromClaudeCode(readFileSync(file, "utf8"));
    const id = basename(file, ".jsonl");
    createTranscript(out, id, prefix, entries);
    const turns = new Set(entries.map((e) => e.turnId)).size;
    const tokens = Math.ceil(JSON.stringify(entries).length / 4);
    console.log(`${id}: ${turns} turns, ${entries.length} messages, ~${Math.round(tokens / 1000)}K tokens -> ${join(out, `${id}.jsonl`)}`);
  }
}
