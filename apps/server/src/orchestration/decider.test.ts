import { describe, expect, test } from "bun:test";
import type { Command, CommandId, ProjectId, TaskId, ThreadId, TurnId } from "@verdandi/contracts";
import { Result } from "effect";
import { type DeciderState, decide, projectIdFor } from "./decider.ts";

const threadId = "thread-1" as ThreadId;
const turnId = "turn-1" as TurnId;
const commandId = "cmd-1" as CommandId;
const route = { harness: "fake", model: "fake", effort: "low" } as const;

const none: DeciderState = { thread: undefined };
const taskId = "task-1" as TaskId;
const idle: DeciderState = {
  thread: {
    projectId: "p1" as ProjectId,
    projectPath: "C:/r",
    route,
    pinned: true,
    archived: false,
    budgetMode: null,
    taskDecision: null,
    taskPlanned: false,
    cachedTokens: 0,
    turns: 0,
    runningTurnId: null,
    sessionId: null,
    taskId: null,
    pendingRequests: [],
  },
};
const running: DeciderState = {
  thread: {
    projectId: "p1" as ProjectId,
    projectPath: "C:/r",
    route,
    pinned: true,
    archived: false,
    budgetMode: null,
    taskDecision: null,
    taskPlanned: false,
    cachedTokens: 0,
    turns: 0,
    runningTurnId: turnId,
    sessionId: "s1",
    taskId,
    pendingRequests: [],
  },
};
const waiting: DeciderState = {
  thread: {
    projectId: "p1" as ProjectId,
    projectPath: "C:/r",
    route,
    pinned: true,
    archived: false,
    budgetMode: null,
    taskDecision: null,
    taskPlanned: false,
    cachedTokens: 0,
    turns: 0,
    runningTurnId: turnId,
    sessionId: "s1",
    taskId,
    pendingRequests: [
      { requestId: "r1", turnId, kind: "approval" },
      { requestId: "r2", turnId, kind: "user-input" },
    ],
  },
};

const create: Command = { type: "thread.create", commandId, threadId, projectPath: "C:/r", route };
const send: Command = { type: "turn.send", commandId, threadId, turnId, text: "hi", mode: "plan" };
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

  test("starts a turn on an idle thread, and a task named after it when none is open", () => {
    const started = { type: "turn.started", v: 1, threadId, turnId, text: "hi", mode: "plan" } as const;
    expect(events(decide(idle, send))).toEqual([
      { type: "task.started", v: 1, threadId, taskId: turnId as string as TaskId, route },
      started,
    ]);
    expect(events(decide({ thread: { ...(idle.thread as NonNullable<DeciderState["thread"]>), taskId } }, send))).toEqual([started]);
  });

  test("rejects a second turn while one is running", () => {
    expect(reason(decide(running, send))).toBe("ThreadBusy");
  });

  test("archives only an idle thread, takes no turns while archived, and unarchives", () => {
    const archive: Command = { type: "thread.archive", commandId, threadId };
    const unarchive: Command = { type: "thread.unarchive", commandId, threadId };
    const archived = { thread: { ...(idle.thread as NonNullable<DeciderState["thread"]>), archived: true } };
    expect(events(decide(idle, archive))).toEqual([{ type: "thread.archived", v: 1, threadId }]);
    expect(events(decide(archived, archive))).toEqual([]);
    const busy = decide(running, archive);
    expect(reason(busy)).toBe("ThreadBusy");
    expect(Result.isFailure(busy) && busy.failure.message).toContain("Interrupt it first");
    const blocked = decide(archived, send);
    expect(reason(blocked)).toBe("ThreadArchived");
    expect(Result.isFailure(blocked) && blocked.failure.message).toContain(`verdandi chat --unarchive ${threadId}`);
    expect(events(decide(archived, unarchive))).toEqual([{ type: "thread.unarchived", v: 1, threadId }]);
    expect(events(decide(idle, unarchive))).toEqual([]);
    expect(reason(decide(none, archive))).toBe("ThreadNotFound");
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

  test("interrupting the running turn denies its requests and ends it as interrupted", () => {
    const interrupt = (turnId: TurnId): Command => ({ type: "turn.interrupt", commandId, threadId, turnId });
    expect(events(decide(waiting, interrupt(turnId))).map((e) => (e.type === "approval.resolved" ? e.reason : e))).toEqual([
      "The user interrupted the turn.",
      "The user interrupted the turn.",
      { type: "turn.completed", v: 1, threadId, turnId, status: "interrupted" },
    ]);
    expect(reason(decide(idle, interrupt(turnId)))).toBe("TurnNotRunning");
    expect(reason(decide(running, interrupt("turn-0" as TurnId)))).toBe("TurnNotRunning");
    expect(reason(decide(none, interrupt(turnId)))).toBe("ThreadNotFound");
  });

  test("drops reports from a turn that has ended, except its session binding", () => {
    expect(events(decide(idle, report({ type: "item", item: { kind: "assistant.message", text: "late" } })))).toEqual([]);
    expect(events(decide(idle, report({ type: "turn.finished", status: "success" })))).toEqual([]);
    const started = report({ type: "session.started", sessionId: "s2", harnessVersion: "1" });
    expect(events(decide(idle, started)).map((e) => e.type)).toEqual(["harness.session.bound"]);
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

  test("a proposed plan waits for allow or deny, and a deny can carry feedback", () => {
    expect(events(decide(running, report({ type: "plan.requested", requestId: "p1", plan: "1. Edit" })))).toEqual([
      { type: "plan.requested", v: 1, threadId, turnId, requestId: "p1", plan: "1. Edit" },
    ]);
    const planning: DeciderState = {
      thread: {
        projectId: "p1" as ProjectId,
        projectPath: "C:/r",
        route,
        pinned: true,
        archived: false,
        budgetMode: null,
        taskDecision: null,
        taskPlanned: false,
        cachedTokens: 0,
        turns: 0,
        runningTurnId: turnId,
        sessionId: "s1",
        taskId,
        pendingRequests: [{ requestId: "p1", turnId, kind: "plan" }],
      },
    };
    expect(events(decide(planning, respond("p1", { decision: "deny", feedback: "smaller" })))).toEqual([
      { type: "approval.resolved", v: 1, threadId, turnId, requestId: "p1", resolution: { decision: "deny", feedback: "smaller" } },
    ]);
    expect(reason(decide(planning, respond("p1", { decision: "answer", answers: {} })))).toBe("InvalidResolution");
  });

  test("approving a plan moves its build before the approval, unless the user pinned the thread since", () => {
    const decision = {
      source: "policy",
      taskClass: "code.feature",
      difficulty: 0.5,
      confidence: 0.9,
      target: { harness: "fake", provider: "fake", model: "fake-large", access: "local" },
      effort: "medium",
      reason: "The plan for this code.feature task is approved, so it runs on fake-large at medium effort.",
      trace: [],
    } as const;
    const routed = (pinned: boolean): DeciderState => ({
      thread: running.thread && {
        ...running.thread,
        pinned,
        pendingRequests: [{ requestId: "p1", turnId, kind: "plan", execute: decision }],
      },
    });
    const to = { harness: "fake", model: "fake-large", effort: "medium" } as const;
    expect(events(decide(routed(false), respond("p1", { decision: "allow" })))).toEqual([
      { type: "task.rerouted", v: 1, threadId, taskId, turnId, from: route, to, decision },
      { type: "approval.resolved", v: 1, threadId, turnId, requestId: "p1", resolution: { decision: "allow" } },
    ]);
    expect(events(decide(routed(true), respond("p1", { decision: "allow" }))).map((e) => e.type)).toEqual(["approval.resolved"]);
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

  test("records a user's route change with what it replaced", () => {
    const to = { ...route, model: "fake-2", effort: "high" } as const;
    expect(events(decide(idle, { type: "thread.route.set", commandId, threadId, route: to }))).toEqual([
      { type: "thread.route.changed", v: 1, threadId, from: route, to, by: "user" },
    ]);
    expect(events(decide(idle, { type: "thread.route.set", commandId, threadId, route }))).toEqual([]);
    expect(reason(decide(none, { type: "thread.route.set", commandId, threadId, route: to }))).toBe("ThreadNotFound");
  });

  test("records a budget mode change, and clearing it, but not setting the one the thread has", () => {
    const set = (mode: "max" | null) => ({ type: "thread.budget.set", commandId, threadId, mode }) as const;
    expect(events(decide(running, set("max")))).toEqual([{ type: "thread.budget.changed", v: 1, threadId, mode: "max" }]);
    expect(events(decide(running, set(null)))).toEqual([]);
    const withMax = { thread: running.thread && { ...running.thread, budgetMode: "max" as const } };
    expect(events(decide(withMax, set(null)))).toEqual([{ type: "thread.budget.changed", v: 1, threadId, mode: null }]);
    expect(reason(decide(none, set("max")))).toBe("ThreadNotFound");
  });

  test("a pin keeps the session's subagents on its harness, ignores ones the client sent, and a new harness starts without", () => {
    const subagents = { explorer: { model: "fake-small", effort: "low" } } as const;
    const warm: DeciderState = { thread: idle.thread && { ...idle.thread, route: { ...route, subagents } } };
    const pin = (to: Extract<Command, { type: "thread.route.set" }>["route"]) => {
      const [e] = events(decide(warm, { type: "thread.route.set", commandId, threadId, route: to }));
      return e?.type === "thread.route.changed" ? e.to : undefined;
    };
    const other = { explorer: { model: "fake-large", effort: "high" } } as const;
    expect(pin({ ...route, model: "fake-2", subagents: other })).toEqual({ ...route, model: "fake-2", subagents });
    expect(pin({ harness: "claude-code", model: "opus", effort: "high", subagents: other })).toEqual({
      harness: "claude-code",
      model: "opus",
      effort: "high",
    });
  });

  test("a running turn defers a model change but blocks a harness change", () => {
    const model = { type: "thread.route.set", commandId, threadId, route: { ...route, model: "fake-2" } } as const;
    expect(events(decide(running, model)).map((e) => e.type)).toEqual(["thread.route.changed"]);
    const harness = { type: "thread.route.set", commandId, threadId, route: { ...route, harness: "claude-code" } } as const;
    expect(reason(decide(running, harness))).toBe("ThreadBusy");
  });

  test("ignores text deltas", () => {
    expect(events(decide(running, report({ type: "text.delta", text: "a" })))).toEqual([]);
  });

  test("projectIdFor treats C:\\A b and c:/A b as the same project", () => {
    expect(projectIdFor("C:\\A b")).toBe(projectIdFor("c:/A b"));
    expect(projectIdFor("C:\\A b")).not.toBe(projectIdFor("C:\\A c"));
  });
});

describe("spend caps", () => {
  const cap = { scope: "project", period: "day", periodKey: "2026-09-30", baseUsd: 5, limitUsd: 5 } as const;
  const withCaps = (spentUsd: number): DeciderState => ({
    ...idle,
    spend: Result.succeed({ file: "C:/home/spend-caps.yaml", caps: [{ ...cap, spentUsd }] }),
  });
  const raise: Command = { type: "spend.cap.raise", commandId, threadId, scope: "project", period: "day" };
  const message = (r: ReturnType<typeof decide>) => (Result.isFailure(r) ? r.failure.message : "");

  test("a reached cap rejects the turn, naming the cap, what it spent and how to raise it", () => {
    expect(reason(decide(withCaps(4.99), send))).toBe("accepted");
    const rejected = decide(withCaps(5.2), send);
    expect(reason(rejected)).toBe("SpendCapReached");
    expect(message(rejected)).toBe(
      "The project's daily cap of metered spend is reached: $5.20 of $5.00 spent today. Raise it for the rest of today with Raise in the web UI or `verdandi chat --raise-cap`, or change daily under projects in C:/home/spend-caps.yaml.",
    );
  });

  test("raising a cap adds its configured amount for the rest of the period", () => {
    expect(events(decide(withCaps(5.2), raise))).toEqual([
      {
        type: "spend.cap.raised",
        v: 1,
        threadId,
        scope: "project",
        projectId: projectIdFor("C:/r"),
        period: "day",
        periodKey: "2026-09-30",
        fromUsd: 5,
        toUsd: 10,
      },
    ]);
  });

  test("a cap that isn't set can't be raised, and a broken caps file rejects turns", () => {
    expect(message(decide(withCaps(0), { ...raise, scope: "profile" }))).toBe(
      "The profile has no daily spend cap to raise. Set daily in C:/home/spend-caps.yaml to add one.",
    );
    expect(reason(decide({ ...idle, spend: Result.fail("spend-caps.yaml: bad") }, send))).toBe("InvalidSpendCaps");
  });
});
