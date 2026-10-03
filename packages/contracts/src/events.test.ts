import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { decodeStoredEvent, type Event, encodeEvent } from "./events.ts";
import type { TaskId, ThreadId, TurnId } from "./ids.ts";

const threadId = "3f1c2b1e-0000-4000-8000-000000000001" as ThreadId;
const turnId = "3f1c2b1e-0000-4000-8000-000000000002" as TurnId;
const route = { harness: "fake", model: "fake", effort: "low" } as const;

const samples: Event[] = [
  { type: "thread.created", v: 1, threadId, projectId: "p1" as never, projectPath: "C:/Users/a b/repo", route },
  { type: "thread.route.changed", v: 1, threadId, from: route, to: { ...route, model: "fake-2" }, by: "user" },
  { type: "task.started", v: 3, threadId, taskId: turnId as string as TaskId, route },
  { type: "thread.archived", v: 1, threadId },
  { type: "thread.unarchived", v: 1, threadId },
  { type: "turn.started", v: 2, threadId, turnId, text: "hi" },
  { type: "turn.started", v: 2, threadId, turnId, text: "hi", mode: "plan" },
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
  { type: "turn.item.added", v: 1, threadId, turnId, item: { kind: "plan", text: "1. Edit", filePath: "C:/Users/a b/.claude/plans/p.md" } },
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
  {
    type: "harness.quota.reported",
    v: 1,
    threadId,
    turnId,
    harness: "claude-code",
    quota: { status: "rejected", window: "five_hour", utilization: 1, resetsAt: "2026-09-30T15:00:00.000Z", usingOverage: true },
  },
  { type: "harness.quota.reported", v: 1, threadId, turnId, harness: "claude-code", quota: { status: "allowed", usingOverage: false } },
  { type: "approval.requested", v: 1, threadId, turnId, requestId: "r1", toolName: "Edit", input: { file_path: "C:/a b/x.ts" } },
  {
    type: "user-input.requested",
    v: 1,
    threadId,
    turnId,
    requestId: "r2",
    questions: [{ question: "Which?", header: "Pick", options: [{ label: "A", description: "a" }], multiSelect: false }],
  },
  { type: "plan.requested", v: 1, threadId, turnId, requestId: "r4", plan: "1. Edit", filePath: "C:/Users/a b/.claude/plans/p.md" },
  { type: "approval.resolved", v: 1, threadId, turnId, requestId: "r1", resolution: { decision: "allow" } },
  { type: "approval.resolved", v: 1, threadId, turnId, requestId: "r4", resolution: { decision: "deny", feedback: "smaller" } },
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
    const result = await Effect.runPromise(Effect.flip(decodeStoredEvent({ type: "turn.started", v: 3, payload: "{}" })));
    expect(result.message).toContain("turn.started");
    expect(result.message).toContain("v3");
    expect(result.message).toContain("newer");
  });

  test("reads a v1 task.started as v3 without router inputs, a v2 as v3 without untrusted input, and keeps a v3 task's", async () => {
    const taskId = turnId as string as TaskId;
    const v1 = { type: "task.started", v: 1, threadId, taskId, route } as const;
    const read = await Effect.runPromise(decodeStoredEvent({ type: "task.started", v: 1, payload: JSON.stringify(v1) }));
    expect(read).toEqual({ ...v1, v: 3 });
    const inputs = { route, pinned: false, budgetMode: "thrifty", warm: true, cachedTokens: 1200, harnesses: ["fake"] } as const;
    const v2 = { type: "task.started", v: 2, threadId, taskId, route, inputs } as const;
    expect(await Effect.runPromise(decodeStoredEvent({ type: "task.started", v: 2, payload: JSON.stringify(v2) }))).toEqual({
      ...v2,
      v: 3,
    });
    const v3: Event = { ...v2, v: 3, inputs: { ...inputs, untrusted: { source: "WebFetch", turn: 3 } } };
    expect(await roundTrip(v3)).toEqual(v3);
  });

  test("reads a v1 memory.proposed, always a background review's, as v2", async () => {
    const v1 = {
      type: "memory.proposed",
      v: 1,
      threadId,
      turnId,
      requestId: "r1",
      scope: "project",
      text: "Tests run with bun test",
      reviewThreadId: threadId,
    } as const;
    const read = await Effect.runPromise(decodeStoredEvent({ type: "memory.proposed", v: 1, payload: JSON.stringify(v1) }));
    expect(read).toEqual({ ...v1, v: 2 });
  });

  test("reads a v1 turn.started as v2 without attachments, and keeps a v2 turn's references", async () => {
    const v1 = { type: "turn.started", v: 1, threadId, turnId, text: "hi", mode: "ask" } as const;
    expect(await Effect.runPromise(decodeStoredEvent({ type: "turn.started", v: 1, payload: JSON.stringify(v1) }))).toEqual({
      ...v1,
      v: 2,
    });
    const ref = { id: `${"c".repeat(64)}.png`, name: "a b.png", kind: "image", mediaType: "image/png", size: 12 } as const;
    const v2: Event = { type: "turn.started", v: 2, threadId, turnId, text: "hi", attachments: [ref] };
    expect(await roundTrip(v2)).toEqual(v2);
    const traversal = { ...v2, attachments: [{ ...ref, id: "../verdandi.db" }] };
    expect((await Effect.runPromise(Effect.flip(decodeStoredEvent(encodeEvent(traversal))))).message).toContain("malformed");
  });

  test("reads a v1 task.escalated as v2 set off by a failed verifier, the only trigger v1 had", async () => {
    const taskId = turnId as string as TaskId;
    const v1 = { type: "task.escalated", v: 1, threadId, taskId, turnId, step: "ask", from: route, reason: "`bun test` failed" } as const;
    expect(await Effect.runPromise(decodeStoredEvent({ type: "task.escalated", v: 1, payload: JSON.stringify(v1) }))).toEqual({
      ...v1,
      v: 2,
      trigger: "verifier",
    });
    const v2: Event = { ...v1, v: 2, trigger: "blocked", step: "effort", to: { ...route, effort: "high" }, nextTurnId: turnId };
    expect(await roundTrip(v2)).toEqual(v2);
  });

  test("reads a v1 revert's files as restored and put back whole, with nothing outside the folder, as v1 did", async () => {
    const restored = { type: "thread.files.restored", v: 1, threadId, from: "refs/a", saved: "refs/b" } as const;
    expect(await Effect.runPromise(decodeStoredEvent({ type: restored.type, v: 1, payload: JSON.stringify(restored) }))).toEqual({
      ...restored,
      v: 2,
      whole: true,
      outside: [],
    });
    const undone = { type: "thread.revert.undone", v: 1, threadId, turnIds: [turnId], restore: "refs/b" } as const;
    expect(await Effect.runPromise(decodeStoredEvent({ type: undone.type, v: 1, payload: JSON.stringify(undone) }))).toEqual({
      ...undone,
      v: 2,
    });
    const v2: Event = { ...restored, v: 2, paths: ["src/a b.ts"], whole: false, outside: ["C:/Users/a b/notes.md"] };
    expect(await roundTrip(v2)).toEqual(v2);
  });

  test("reads a v1 skill.applied as v2, its turn kept; a revert's v2 has none", async () => {
    const v1 = {
      type: "skill.applied",
      v: 1,
      threadId,
      turnId,
      requestId: "r1",
      action: "patch",
      skill: "deploy-notes",
      path: "SKILL.md",
    } as const;
    expect(await Effect.runPromise(decodeStoredEvent({ type: "skill.applied", v: 1, payload: JSON.stringify(v1) }))).toEqual({
      ...v1,
      v: 2,
    });
    const { turnId: _, ...revert } = { ...v1, v: 2 } as const;
    expect(await roundTrip(revert)).toEqual(revert);
  });

  test("round-trips CRLF and unicode text", async () => {
    const e: Event = { type: "turn.started", v: 2, threadId, turnId, text: "räksmörgås\r\n日本語 \u{1F600}" };
    expect(await roundTrip(e)).toEqual(e);
  });
});
