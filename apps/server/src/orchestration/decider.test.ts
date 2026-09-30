import { describe, expect, test } from "bun:test";
import type { Command, CommandId, ThreadId, TurnId } from "@verdandi/contracts";
import { Result } from "effect";
import { type DeciderState, decide, projectIdFor } from "./decider.ts";

const threadId = "thread-1" as ThreadId;
const turnId = "turn-1" as TurnId;
const commandId = "cmd-1" as CommandId;
const route = { harness: "fake", model: "fake", effort: "low" } as const;

const none: DeciderState = { thread: undefined };
const idle: DeciderState = { thread: { projectPath: "C:/r", runningTurnId: null, sessionId: null, pendingRequests: [] } };
const running: DeciderState = { thread: { projectPath: "C:/r", runningTurnId: turnId, sessionId: "s1", pendingRequests: [] } };
const waiting: DeciderState = {
  thread: {
    projectPath: "C:/r",
    runningTurnId: turnId,
    sessionId: "s1",
    pendingRequests: [
      { requestId: "r1", turnId, kind: "approval" },
      { requestId: "r2", turnId, kind: "user-input" },
    ],
  },
};

const create: Command = { type: "thread.create", commandId, threadId, projectPath: "C:/r", route };
const send: Command = { type: "turn.send", commandId, threadId, turnId, text: "hi" };
const report = (event: Extract<Command, { type: "harness.report" }>["event"]): Command => ({
  type: "harness.report",
  commandId,
  threadId,
  turnId,
  event,
});

const respond = (requestId: string, resolution: Extract<Command, { type: "approval.respond" }>["resolution"]): Command => ({
  type: "approval.respond",
  commandId,
  threadId,
  requestId,
  resolution,
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

  test("steers only the running turn", () => {
    const steer = (turnId: TurnId): Command => ({ type: "turn.steer", commandId, threadId, turnId, text: "go left" });
    expect(events(decide(running, steer(turnId)))).toEqual([{ type: "turn.steered", v: 1, threadId, turnId, text: "go left" }]);
    expect(reason(decide(idle, steer(turnId)))).toBe("TurnNotRunning");
    expect(reason(decide(running, steer("turn-0" as TurnId)))).toBe("TurnNotRunning");
    expect(reason(decide(none, steer(turnId)))).toBe("ThreadNotFound");
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
      { type: "turn.completed", v: 1, threadId, turnId, status: "interrupted", error: "verdandid stopped during this turn" },
    ]);
    expect(events(decide(idle, { type: "turn.recover", commandId, threadId, turnId }))).toEqual([]);
  });

  test("answers a pending request", () => {
    expect(events(decide(waiting, respond("r1", { decision: "allow" })))).toEqual([
      { type: "approval.resolved", v: 1, threadId, turnId, requestId: "r1", resolution: { decision: "allow" } },
    ]);
    expect(events(decide(waiting, respond("r2", { decision: "answer", answers: { "Which?": "A" } }))).map((e) => e.type)).toEqual([
      "approval.resolved",
    ]);
  });

  test("rejects answers to requests that aren't pending or don't fit", () => {
    expect(reason(decide(running, respond("r1", { decision: "allow" })))).toBe("RequestNotPending");
    expect(reason(decide(waiting, respond("r1", { decision: "answer", answers: {} })))).toBe("InvalidResolution");
    expect(reason(decide(waiting, respond("r2", { decision: "allow" })))).toBe("InvalidResolution");
  });

  test("a turn that ends denies its pending requests, then completes", () => {
    const finished = events(decide(waiting, report({ type: "turn.finished", status: "success" })));
    expect(finished.map((e) => (e.type === "approval.resolved" ? [e.requestId, e.resolution.decision] : e.type))).toEqual([
      ["r1", "deny"],
      ["r2", "deny"],
      "turn.completed",
    ]);
    const recovered = events(decide(waiting, { type: "turn.recover", commandId, threadId, turnId }));
    expect(recovered[0]).toMatchObject({ type: "approval.resolved", reason: "verdandid stopped while this was waiting for an answer." });
    expect(recovered.at(-1)?.type).toBe("turn.completed");
  });

  test("ignores text deltas", () => {
    expect(events(decide(running, report({ type: "text.delta", text: "a" })))).toEqual([]);
  });

  test("projectIdFor treats C:\\A b and c:/A b as the same project", () => {
    expect(projectIdFor("C:\\A b")).toBe(projectIdFor("c:/A b"));
    expect(projectIdFor("C:\\A b")).not.toBe(projectIdFor("C:\\A c"));
  });
});
