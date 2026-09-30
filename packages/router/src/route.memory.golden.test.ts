import { expect, test } from "bun:test";
import type { Route, RouteDecision, RouteStats } from "@verdandi/contracts";
import { loadPolicy } from "./policy.ts";
import { route } from "./route.ts";
import { rules } from "./rules.ts";

// Routing memory (DESIGN §8.8) over synthetic outcomes. A local fix routes to sonnet at medium effort by policy.
const FIX = "Fix the date parsing bug in src/dates.ts";
const cc = (model: string, effort: Route["effort"]): Route => ({ harness: "claude-code", model, effort });
const policyRoute = cc("sonnet", "medium");
const stats = (s: Partial<RouteStats>): RouteStats => ({
  taskClass: "code.edit.local",
  route: policyRoute,
  tasks: 10,
  completed: 10,
  failed: 0,
  escalated: 0,
  reverted: 0,
  overrides: [],
  ...s,
});
const policy = loadPolicy();
const routeWith = (memory: RouteStats[], pinned = false) =>
  route(
    {
      text: FIX,
      mode: "build",
      memory,
      ...(pinned && {
        pin: { target: { harness: "claude-code", provider: "claude-subscription", model: "haiku", access: "subscription" }, effort: "low" },
      }),
    },
    policy,
    rules,
  );
const picked = (d: ReturnType<typeof route>) => `${d.target.model} ${d.effort}`;

const GOLDENS: { name: string; memory: RouteStats[]; route: string; source: RouteDecision["source"]; reason?: string }[] = [
  { name: "no memory keeps the policy's route", memory: [], route: "sonnet medium", source: "policy" },
  {
    name: "overrides below the minimum sample don't move it",
    memory: [stats({ tasks: 4, overrides: [{ to: cc("opus", "high"), count: 4 }] })],
    route: "sonnet medium",
    source: "policy",
  },
  {
    name: "overrides below the minimum share don't move it",
    memory: [stats({ overrides: [{ to: cc("opus", "high"), count: 4 }] })],
    route: "sonnet medium",
    source: "policy",
  },
  {
    name: "the user's usual override moves it",
    memory: [stats({ overrides: [{ to: cc("opus", "high"), count: 7 }] })],
    route: "opus high",
    source: "memory",
    reason: "code.edit.local tasks here were moved off sonnet by you 7 of 10 times, so it starts on opus at high effort.",
  },
  {
    name: "an effort-only override names the effort it moved off",
    memory: [stats({ tasks: 5, overrides: [{ to: cc("sonnet", "high"), count: 5 }] })],
    route: "sonnet high",
    source: "memory",
    reason: "code.edit.local tasks here were moved off sonnet at medium effort by you 5 of 5 times, so it starts on sonnet at high effort.",
  },
  {
    name: "tasks that mostly didn't succeed move one tier up",
    memory: [stats({ tasks: 6, completed: 2, failed: 3, reverted: 1 })],
    route: "opus medium",
    source: "memory",
    reason: "code.edit.local tasks here didn't succeed on sonnet 4 of 6 times, so it starts on the stronger opus at medium effort.",
  },
  {
    name: "memory of another class or route doesn't apply",
    memory: [
      stats({ taskClass: "review", overrides: [{ to: cc("opus", "high"), count: 10 }] }),
      stats({ route: cc("sonnet", "low"), overrides: [{ to: cc("opus", "high"), count: 10 }] }),
    ],
    route: "sonnet medium",
    source: "policy",
  },
];

for (const g of GOLDENS) {
  test(g.name, () => {
    const d = routeWith(g.memory);
    expect(picked(d)).toBe(g.route);
    expect(d.source).toBe(g.source);
    if (g.reason) expect(d.reason).toBe(g.reason);
    // RoutingExplain shows the memory the router consulted, even when it didn't move the route.
    expect(d.memory).toEqual(
      g.memory.find((s) => s.taskClass === "code.edit.local" && s.route.model === "sonnet" && s.route.effort === "medium"),
    );
    expect(d.trace.some((t) => t.stage === "memory")).toBe(d.memory !== undefined);
  });
}

test("a pinned task ignores routing memory", () => {
  const d = routeWith([stats({ overrides: [{ to: cc("opus", "high"), count: 10 }] })], true);
  expect(d).toMatchObject({ source: "pin", effort: "low" });
  expect(d.memory).toBeUndefined();
});

test("a project policy can raise the evidence memory needs", () => {
  const strict = loadPolicy([{ source: "test", data: { memory: { minTasks: 20, minShare: 0.9 } } }]);
  const d = route({ text: FIX, mode: "build", memory: [stats({ overrides: [{ to: cc("opus", "high"), count: 7 }] })] }, strict, rules);
  expect(picked(d)).toBe("sonnet medium");
  expect(d.trace.find((t) => t.stage === "memory")?.note).toContain("too few to act on (minTasks 20)");
});
