import { describe, expect, test } from "bun:test";
import type { Command, CommandId, ThreadId, TurnId } from "@goldiloop/contracts";
import { Result } from "effect";
import { type DeciderState, decide, projectIdFor } from "./decider.ts";

const threadId = "thread-1" as ThreadId;
const turnId = "turn-1" as TurnId;
const commandId = "cmd-1" as CommandId;
const route = { harness: "fake", model: "fake", effort: "low" } as const;

const none: DeciderState = { thread: undefined };
const idle: DeciderState = { thread: { projectPath: "C:/r", runningTurnId: null, sessionId: null } };
const running: DeciderState = { thread: { projectPath: "C:/r", runningTurnId: turnId, sessionId: "s1" } };

const create: Command = { type: "thread.create", commandId, threadId, projectPath: "C:/r", route };
const send: Command = { type: "turn.send", commandId, threadId, turnId, text: "hi" };
const report = (event: Extract<Command, { type: "harness.report" }>["event"]): Command => ({
  type: "harness.report",
  commandId,
  threadId,
  turnId,
  event,
});

const reason = (r: ReturnType<typeof decide>) => (Result.isFailure(r) ? r.failure.reason : "accepted");
const events = (r: ReturnType<typeof decide>) => Result.getOrThrow(r);

describe("decide", () => {
  test("creates a thread once", () => {
    expect(events(decide(none, create)).map((e) => e.type)).toEqual(["thread.created"]);
    expect(reason(decide(idle, create))).toBe("ThreadExists");
  });

  test("rejects a turn for an unknown thread", () => {
    expect(reason(decide(none, send))).toBe("ThreadNotFound");
  });

  test("starts a turn on an idle thread", () => {
    expect(events(decide(idle, send))).toEqual([{ type: "turn.started", v: 1, threadId, turnId, text: "hi" }]);
  });

  test("rejects a second turn while one is running", () => {
    expect(reason(decide(running, send))).toBe("ThreadBusy");
  });

  test("maps a finished harness turn to turn.completed", () => {
    expect(events(decide(running, report({ type: "turn.finished", status: "error", error: "x" })))).toEqual([
      { type: "turn.completed", v: 1, threadId, turnId, status: "error", error: "x" },
    ]);
  });

  test("binds a new harness session only when it changes", () => {
    const started = report({ type: "session.started", sessionId: "s2", harnessVersion: "1" });
    expect(events(decide(running, started)).map((e) => e.type)).toEqual(["harness.session.bound"]);
    const same = report({ type: "session.started", sessionId: "s1", harnessVersion: "1" });
    expect(events(decide(running, same))).toEqual([]);
  });

  test("recovering a running turn marks it interrupted", () => {
    expect(events(decide(running, { type: "turn.recover", commandId, threadId, turnId }))).toEqual([
      { type: "turn.completed", v: 1, threadId, turnId, status: "interrupted", error: "goldiloopd stopped during this turn" },
    ]);
    expect(events(decide(idle, { type: "turn.recover", commandId, threadId, turnId }))).toEqual([]);
  });

  test("ignores text deltas", () => {
    expect(events(decide(running, report({ type: "text.delta", text: "a" })))).toEqual([]);
  });

  test("projectIdFor treats C:\\A b and c:/A b as the same project", () => {
    expect(projectIdFor("C:\\A b")).toBe(projectIdFor("c:/A b"));
    expect(projectIdFor("C:\\A b")).not.toBe(projectIdFor("C:\\A c"));
  });
});
