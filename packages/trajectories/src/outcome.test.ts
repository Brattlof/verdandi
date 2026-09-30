import { expect, test } from "bun:test";
import type { Event, ProjectId, StoredEvent, TaskId, ThreadId, TurnId } from "@verdandi/contracts";
import { buildTaskOutcomes } from "./outcome.ts";

const threadId = "t1" as ThreadId;
const sonnet = { harness: "claude-code", model: "sonnet", effort: "high" } as const;
const opus = { ...sonnet, model: "opus" } as const;
const usage = (turnId: TurnId, model: string, costUsd: number) =>
  ({
    type: "turn.usage.recorded",
    v: 1,
    threadId,
    turnId,
    model,
    accessMode: "metered",
    inputTokens: 10,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
  }) as const;
/** Each event is `[second it happened at, event]`. */
const stored = (events: [number, Event][]): StoredEvent[] =>
  events.map(([s, event], i) => ({ seq: i + 1, eventId: `e${i}`, commandId: `c${i}`, at: new Date(s * 1000).toISOString(), event }));
const [u0, u1, u2, u3, u4] = ["u0", "u1", "u2", "u3", "u4"] as [TurnId, TurnId, TurnId, TurnId, TurnId];
const started = (turnId: TurnId) => ({ type: "turn.started", v: 1, threadId, turnId, text: "go" }) as const;
const completed = (turnId: TurnId, status: "success" | "interrupted") =>
  ({ type: "turn.completed", v: 1, threadId, turnId, status }) as const;

const events = stored([
  [0, { type: "thread.created", v: 1, threadId, projectId: "p" as ProjectId, projectPath: "/repo", route: sonnet }],
  // A turn from before tasks existed belongs to none.
  [0, started(u0)],
  [0, completed(u0, "success")],
  [10, { type: "task.started", v: 1, threadId, taskId: u1 as string as TaskId, route: sonnet }],
  [10, started(u1)],
  [11, { type: "turn.steered", v: 1, threadId, turnId: u1, text: "left" }],
  [11, usage(u1, "sonnet", 0.25)],
  [12, completed(u1, "success")],
  [20, started(u2)],
  [20, { type: "plan.requested", v: 1, threadId, turnId: u2, requestId: "r1", plan: "1. Edit" }],
  // Verdandi denying a plan when its turn ends is not the user correcting the agent.
  [21, { type: "approval.resolved", v: 1, threadId, turnId: u2, requestId: "r1", resolution: { decision: "deny" }, reason: "ended" }],
  [21, usage(u2, "sonnet", 0.25)],
  [21, usage(u2, "haiku", 0.5)],
  [21, completed(u2, "success")],
  [30, { type: "thread.route.changed", v: 1, threadId, from: sonnet, to: opus, by: "user" }],
  [40, { type: "task.started", v: 1, threadId, taskId: u3 as string as TaskId, route: opus }],
  [40, started(u3)],
  [45, completed(u3, "interrupted")],
  [50, started(u4)],
  [52, completed(u4, "success")],
]);

test("an overridden task records its turns, usage by model, running time and the override", () => {
  const [first] = buildTaskOutcomes(events);
  expect(first).toEqual({
    v: 1,
    taskId: u1 as string as TaskId,
    threadId,
    route: sonnet,
    status: "completed",
    turns: 2,
    // One steer plus the override.
    implicitSatisfaction: -1,
    userOverride: { from: sonnet, to: opus },
    verifierRuns: [],
    escalations: 0,
    usage: [
      { model: "sonnet", accessMode: "metered", inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 },
      { model: "haiku", accessMode: "metered", inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 },
    ],
    wallMs: 3000,
  });
});

test("a task counts the user's interrupt as a correction, and has no outcome while its last turn runs", () => {
  const second = buildTaskOutcomes(events)[1];
  expect(second).toMatchObject({ taskId: u3, route: opus, status: "completed", turns: 2, implicitSatisfaction: 0, wallMs: 7000 });
  expect(second?.userOverride).toBeUndefined();
  expect(buildTaskOutcomes(events.slice(0, -1)).map((o) => o.taskId)).toEqual([u1 as string as TaskId]);
});
