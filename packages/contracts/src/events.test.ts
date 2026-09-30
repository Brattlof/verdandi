import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { decodeStoredEvent, type Event, encodeEvent } from "./events.ts";
import type { ThreadId, TurnId } from "./ids.ts";

const threadId = "3f1c2b1e-0000-4000-8000-000000000001" as ThreadId;
const turnId = "3f1c2b1e-0000-4000-8000-000000000002" as TurnId;
const route = { harness: "fake", model: "fake", effort: "low" } as const;

const samples: Event[] = [
  { type: "thread.created", v: 1, threadId, projectId: "p1" as never, projectPath: "C:/Users/a b/repo", route },
  { type: "turn.started", v: 1, threadId, turnId, text: "hi" },
  { type: "harness.session.bound", v: 1, threadId, sessionId: "s1", harnessVersion: "2.1.284" },
  { type: "turn.item.added", v: 1, threadId, turnId, item: { kind: "assistant.message", text: "hello" } },
  {
    type: "turn.item.added",
    v: 1,
    threadId,
    turnId,
    item: { kind: "tool.call", toolUseId: "t1", name: "Read", input: { file_path: "x" } },
  },
  { type: "turn.item.added", v: 1, threadId, turnId, item: { kind: "tool.result", toolUseId: "t1", isError: false, content: "ok" } },
  { type: "turn.steered", v: 1, threadId, turnId, text: "go left" },
  {
    type: "turn.usage.recorded",
    v: 1,
    threadId,
    turnId,
    model: "claude-sonnet-5-5",
    accessMode: "metered",
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    costUsd: 0.01,
  },
  { type: "approval.requested", v: 1, threadId, turnId, requestId: "r1", toolName: "Edit", input: { file_path: "C:/a b/x.ts" } },
  {
    type: "user-input.requested",
    v: 1,
    threadId,
    turnId,
    requestId: "r2",
    questions: [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "a" }], multiSelect: false }],
  },
  { type: "approval.resolved", v: 1, threadId, turnId, requestId: "r1", resolution: { decision: "allow" } },
  { type: "approval.resolved", v: 1, threadId, turnId, requestId: "r2", resolution: { decision: "answer", answers: { "Which?": "A" } } },
  { type: "approval.resolved", v: 1, threadId, turnId, requestId: "r3", resolution: { decision: "deny" }, reason: "turn ended" },
  { type: "turn.completed", v: 1, threadId, turnId, status: "error", error: "boom" },
];

const roundTrip = (e: Event) => Effect.runPromise(decodeStoredEvent(encodeEvent(e)));

describe("stored events", () => {
  test("decodes every v1 event it encodes", async () => {
    for (const e of samples) expect(await roundTrip(e)).toEqual(e);
  });

  test("rejects an unknown event version with a clear message", async () => {
    const result = await Effect.runPromise(Effect.flip(decodeStoredEvent({ type: "turn.started", v: 2, payload: "{}" })));
    expect(result.message).toContain("turn.started");
    expect(result.message).toContain("v2");
    expect(result.message).toContain("newer");
  });

  test("round-trips CRLF and unicode text", async () => {
    const e: Event = { type: "turn.started", v: 1, threadId, turnId, text: "räksmörgås\r\n日本語 \u{1F600}" };
    expect(await roundTrip(e)).toEqual(e);
  });
});
