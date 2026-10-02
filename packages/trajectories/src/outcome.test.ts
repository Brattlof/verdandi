import { expect, test } from "bun:test";
import type { Event, ProjectId, Resolution, Route, StoredEvent, TaskId, ThreadId, TurnId } from "@verdandi/contracts";
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
const started = (turnId: TurnId) => ({ type: "turn.started", v: 2, threadId, turnId, text: "go" }) as const;
const completed = (turnId: TurnId, status: "success" | "interrupted") =>
  ({ type: "turn.completed", v: 1, threadId, turnId, status }) as const;

const events = stored([
  [0, { type: "thread.created", v: 1, threadId, projectId: "p" as ProjectId, projectPath: "/repo", route: sonnet }],
  // A turn from before tasks existed belongs to none.
  [0, started(u0)],
  [0, completed(u0, "success")],
  [10, { type: "task.started", v: 3, threadId, taskId: u1 as string as TaskId, route: sonnet }],
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
  [40, { type: "task.started", v: 3, threadId, taskId: u3 as string as TaskId, route: opus }],
  [40, started(u3)],
  [45, completed(u3, "interrupted")],
  [50, started(u4)],
  [52, completed(u4, "success")],
]);

test("an overridden task records its turns, usage by model, running time and the override", () => {
  const [first] = buildTaskOutcomes(events);
  expect(first).toEqual({
    v: 3,
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
    triggers: [],
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

test("approving a plan with the user's edit is a correction; approving it as proposed is not", () => {
  const planned = (resolution: Resolution) =>
    buildTaskOutcomes(
      stored([
        [0, { type: "task.started", v: 3, threadId, taskId: u1 as string as TaskId, route: sonnet }],
        [0, started(u1)],
        [1, { type: "plan.requested", v: 1, threadId, turnId: u1, requestId: "r1", plan: "1. Edit" }],
        [2, { type: "approval.resolved", v: 1, threadId, turnId: u1, requestId: "r1", resolution }],
        [3, completed(u1, "success")],
      ]),
    )[0]?.implicitSatisfaction;
  expect(planned({ decision: "allow", plan: "1. Edit b" })).toBe(0);
  expect(planned({ decision: "allow" })).toBe(1);
});

test("a follow-up the decision layer calls a correction counts against the task that answered before it", () => {
  const correcting = (turnId: TurnId, probability: number, lowConfidence = false) =>
    ({
      type: "decision.recorded",
      v: 2,
      threadId,
      turnId,
      questions: [{ type: "noul", kind: "follow-up.correcting", question: "Correcting?", minConfidence: 0.6 }],
      answers: [
        { type: "noul", kind: "follow-up.correcting", probability, confidence: lowConfidence ? 0.4 : 0.8, lowConfidence, backend: "rules" },
      ],
    }) as const;
  const task = (taskId: TurnId) => ({ type: "task.started", v: 3, threadId, taskId: taskId as string as TaskId, route: sonnet }) as const;
  const outcomes = buildTaskOutcomes(
    stored([
      [0, task(u1)],
      [0, started(u1)],
      [1, completed(u1, "success")],
      // Corrects u1's answer, in the same task.
      [2, correcting(u2, 0.85)],
      [2, started(u2)],
      [3, completed(u2, "success")],
      // Too unsure to count, then a new task whose first turn corrects the previous task's last answer.
      [4, correcting(u3, 0.6, true)],
      [4, started(u3)],
      [5, completed(u3, "success")],
      [6, correcting(u4, 0.85)],
      [6, task(u4)],
      [6, started(u4)],
      [7, completed(u4, "success")],
    ]),
  );
  expect(outcomes.map((o) => [o.taskId as string, o.implicitSatisfaction])).toEqual([
    [u1, -1],
    [u4, 1],
  ]);
});

test("only the user's last route pick counts, and changing back to the task's own route overrides nothing", () => {
  const routed = { ...sonnet, subagents: { explorer: { model: "haiku", effort: "low" } } } as const;
  const haiku = { ...sonnet, model: "haiku" } as const;
  const picked = (...picks: Route[]) =>
    buildTaskOutcomes(
      stored([
        [0, { type: "task.started", v: 3, threadId, taskId: u1 as string as TaskId, route: routed }],
        [0, started(u1)],
        [1, completed(u1, "success")],
        ...picks.map((to, i): [number, Event] => [
          2 + i,
          { type: "thread.route.changed", v: 1, threadId, from: picks[i - 1] ?? routed, to, by: "user" },
        ]),
      ]),
    )[0];
  // Same harness, model and effort is the task's own route, whatever its subagents.
  expect(picked(opus, sonnet)).toMatchObject({ implicitSatisfaction: 1 });
  expect(picked(opus, sonnet)?.userOverride).toBeUndefined();
  expect(picked(opus, haiku)).toMatchObject({ implicitSatisfaction: 0, userOverride: { from: routed, to: haiku } });
  expect(picked(opus, { ...sonnet, effort: "low" })?.userOverride).toEqual({ from: routed, to: { ...sonnet, effort: "low" } });
});
