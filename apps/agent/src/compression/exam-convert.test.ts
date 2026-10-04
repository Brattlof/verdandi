import { expect, test } from "bun:test";
import { fromClaudeCode } from "./exam-convert.ts";

const line = (value: unknown) => JSON.stringify(value);
const user = (content: unknown, more: object = {}) => line({ type: "user", message: { role: "user", content }, ...more });
const assistant = (content: unknown[], more: object = {}) => line({ type: "assistant", message: { role: "assistant", content }, ...more });
// Built from parts, so the source holds no key-shaped string.
const key = ["sk", "ant", "api03", "x".repeat(30)].join("-");

test("a Claude Code session becomes native entries: turns, paired tool calls, steers, no thinking, secrets masked", () => {
  const session = [
    line({ type: "queue-operation", operation: "enqueue" }),
    user("Fix #12 in src/pay.ts"),
    assistant([{ type: "thinking", thinking: "hmm", signature: "sig" }]),
    assistant([{ type: "text", text: "Running the tests." }]),
    assistant([{ type: "tool_use", id: "toolu_a", name: "Bash", input: { command: "bun test" } }]),
    assistant([{ type: "tool_use", id: "toolu_b", name: "Read", input: { file_path: "src/pay.ts" } }]),
    line({ type: "attachment", attachment: { type: "queued_command", prompt: "Use the staging key" } }),
    user([{ type: "tool_result", tool_use_id: "toolu_a", content: `1 fail\nANTHROPIC_API_KEY=${key}`, is_error: true }]),
    user([
      {
        type: "tool_result",
        tool_use_id: "toolu_b",
        content: [
          { type: "text", text: "export const pay" },
          { type: "image", source: {} },
        ],
      },
    ]),
    user([{ type: "text", text: "Base directory for this skill: ..." }], { isMeta: true }),
    assistant([{ type: "text", text: "A subagent's step" }], { isSidechain: true }),
    assistant([{ type: "tool_use", id: "toolu_c", name: "Bash", input: { command: "sleep 60", run_in_background: true } }]),
    user([{ type: "text", text: "commit and merge" }]),
    user([{ type: "tool_result", tool_use_id: "toolu_c", content: "done" }]),
    user([{ type: "tool_result", tool_use_id: "toolu_a", content: "a repeat" }]),
  ].join("\n");

  const { prefix, entries } = fromClaudeCode(session);

  expect(prefix.tools.map((t) => t.name)).toEqual(["Bash", "Read"]);
  expect(entries.map((e) => [e.turnId, e.message.role])).toEqual([
    ["turn-1", "user"],
    ["turn-1", "assistant"],
    ["turn-1", "user"],
    ["turn-1", "assistant"],
    ["turn-2", "user"],
  ]);
  expect(entries[1]?.message.content.map((b) => b.type)).toEqual(["text", "tool_use", "tool_use"]);
  const results = JSON.stringify(entries[2]?.message.content);
  // The steer joins the results; the image is named; the key is masked.
  expect(entries[2]?.message.content.map((b) => b.type)).toEqual(["text", "tool_result", "tool_result"]);
  expect(results).toContain("Use the staging key");
  expect(results).toContain("[image]");
  expect(results).not.toContain(key);
  expect(results).toContain("[REDACTED]");
  // A result after the user moved on is text in the new turn; a repeated one is dropped.
  const late = JSON.stringify(entries[4]?.message.content);
  expect(late).toContain("The result of the earlier Bash call toolu_c:\\ndone");
  expect(late).not.toContain("a repeat");
  expect(JSON.stringify(entries)).not.toMatch(/thinking|subagent|skill/);
});
