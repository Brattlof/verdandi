import { expect, test } from "bun:test";
import type { Item, Route, TaskId, TurnId } from "@verdandi/contracts";
import { escalationToUndo, switchCost } from "./route.tsx";

const route: Route = { harness: "claude-code", model: "sonnet", effort: "medium" };
const warm = { route, sessionId: "s1", turns: [] };

test("a model or effort change on a warm Claude Code or native session warns of the cold cache", () => {
  expect(switchCost(warm, { ...route, model: "opus" })).toContain("cold cache write");
  expect(switchCost(warm, { ...route, effort: "high" })).toContain("cold cache write");
  const native: Route = { harness: "native", model: "claude-sonnet-5-5", effort: "medium" };
  expect(switchCost({ ...warm, route: native }, { ...native, effort: "high" })).toContain("cold cache write");
  expect(switchCost({ ...warm, sessionId: null }, { ...route, model: "opus" })).toBeUndefined();
});

test("an effort change costs nothing extra on the fake harness; a harness change starts a fresh session", () => {
  const fake: Route = { harness: "fake", model: "fake", effort: "low" };
  expect(switchCost({ ...warm, route: fake }, { ...fake, effort: "high" })).toBeUndefined();
  expect(switchCost(warm, { ...route, harness: "fake" })).toContain("fresh session");
});

test("a thread with no session yet, like a fresh one, loses nothing to a harness change", () => {
  expect(switchCost({ ...warm, sessionId: null }, { ...route, harness: "fake" })).toBeUndefined();
});

test("the task's latest escalation can be undone until its route moves again or the thread is pinned", () => {
  const medium: Route = { harness: "fake", model: "fake", effort: "medium" };
  const high: Route = { ...medium, effort: "high" };
  const escalation: Item = { kind: "escalation", step: "effort", from: medium, to: high, reason: "Your message reads as a correction" };
  const turns = [
    { turnId: "t1" as TurnId, items: [] },
    { turnId: "t2" as TurnId, items: [escalation] },
    { turnId: "t3" as TurnId, items: [] },
  ];
  const thread = { pinned: false, route: high, task: { taskId: "t2" as TaskId }, turns };
  expect(escalationToUndo(thread)).toEqual(escalation);
  // Moved again, pinned, or from an earlier task: nothing to undo.
  expect(escalationToUndo({ ...thread, route: { ...high, model: "fake-large" } })).toBeUndefined();
  expect(escalationToUndo({ ...thread, pinned: true })).toBeUndefined();
  expect(escalationToUndo({ ...thread, task: { taskId: "t3" as TaskId } })).toBeUndefined();
  expect(escalationToUndo({ ...thread, task: null })).toBeUndefined();
  // At `ask` nothing moved.
  const { to: _, ...ask } = escalation;
  expect(
    escalationToUndo({ ...thread, route: medium, turns: [{ turnId: "t2" as TurnId, items: [{ ...ask, step: "ask" }] }] }),
  ).toBeUndefined();
});
