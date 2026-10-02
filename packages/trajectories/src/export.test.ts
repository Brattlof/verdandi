import { expect, test } from "bun:test";
import type { Item, ProjectId, TaskId, ThreadId, Trajectory, TurnId } from "@verdandi/contracts";
import { toMessageExamples } from "./export.ts";

const route = { harness: "fake", model: "fake", effort: "low" } as const;
const threadId = "t1" as ThreadId;
const projectId = "p1" as ProjectId;
const turn = (turnId: string, text: string, items: Item[], taskId?: string): Trajectory => ({
  v: 1,
  threadId,
  turnId: turnId as TurnId,
  ...(taskId ? { taskId: taskId as TaskId } : {}),
  projectId,
  text,
  mode: "build",
  route,
  provenance: { provider: "fake" },
  items,
  usage: [],
  outcome: { status: "success" },
  startedAt: "2026-01-01T00:00:00Z",
  completedAt: "2026-01-01T00:00:01Z",
});

test("a task's turns become one conversation: parallel tool calls share a message, subagents are left out, a steer waits for the results", () => {
  const examples = toMessageExamples([
    turn(
      "u1",
      "fix it",
      [
        { kind: "assistant.message", text: "Reading both." },
        { kind: "tool.call", toolUseId: "a", name: "Read", input: { file_path: "a.ts" } },
        { kind: "tool.call", toolUseId: "b", name: "Agent", input: { prompt: "read b.ts" } },
        { kind: "user.steer", text: "also check c.ts" },
        { kind: "tool.call", toolUseId: "s", name: "Read", input: { file_path: "b.ts" }, parentToolUseId: "b" },
        { kind: "tool.result", toolUseId: "s", isError: false, content: "b", parentToolUseId: "b" },
        { kind: "tool.result", toolUseId: "a", isError: false, content: "a" },
        { kind: "tool.result", toolUseId: "b", isError: false, content: "b says b" },
        { kind: "verifier", command: "bun test", passed: true, exitCode: 0, durationMs: 1, output: "" },
        { kind: "assistant.message", text: "Done." },
      ],
      "u1",
    ),
    turn("u2", "thanks", [{ kind: "assistant.message", text: "You're welcome." }], "u1"),
    turn("u3", "before tasks", [{ kind: "assistant.message", text: "ok" }]),
  ]);
  expect(examples).toEqual([
    {
      messages: [
        { role: "user", content: "fix it" },
        {
          role: "assistant",
          content: "Reading both.",
          tool_calls: [
            { id: "a", type: "function", function: { name: "Read", arguments: '{"file_path":"a.ts"}' } },
            { id: "b", type: "function", function: { name: "Agent", arguments: '{"prompt":"read b.ts"}' } },
          ],
        },
        { role: "tool", tool_call_id: "a", content: "a" },
        { role: "tool", tool_call_id: "b", content: "b says b" },
        { role: "user", content: "also check c.ts" },
        { role: "assistant", content: "Done." },
        { role: "user", content: "thanks" },
        { role: "assistant", content: "You're welcome." },
      ],
      metadata: { v: 1, taskId: "u1" as TaskId, threadId, projectId, route, status: "success" },
    },
    {
      messages: [
        { role: "user", content: "before tasks" },
        { role: "assistant", content: "ok" },
      ],
      metadata: { v: 1, threadId, projectId, route, status: "success" },
    },
  ]);
});
