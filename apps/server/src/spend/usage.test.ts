import { expect, test } from "bun:test";
import { type CatalogEntry, Effort, type TaskId, type TaskOutcome, type ThreadId } from "@verdandi/contracts";
import { periodStart, summarizeOutcomes } from "./usage.ts";

const route = { harness: "fake", model: "fake", effort: "low" } as const;
const baseline: CatalogEntry = {
  harness: "claude-code",
  provider: "claude-subscription",
  model: "opus",
  access: "subscription",
  tier: "L",
  context: 1_000_000,
  vision: true,
  efforts: Effort.literals,
  price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};
const usage = (accessMode: "metered" | "subscription", costUsd: number) => ({
  model: "sonnet",
  accessMode,
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  cacheReadTokens: 2_000_000,
  cacheWriteTokens: 0,
  costUsd,
});
const outcome = (status: TaskOutcome["status"], extra: Partial<TaskOutcome> = {}): TaskOutcome => ({
  v: 3,
  taskId: crypto.randomUUID() as TaskId,
  threadId: "t1" as ThreadId,
  route,
  status,
  turns: 1,
  implicitSatisfaction: 0,
  verifierRuns: [],
  escalations: 0,
  triggers: [],
  usage: [],
  wallMs: 0,
  ...extra,
});

test("costs by class keep metered and subscription apart, count failures, and price the Opus baseline as an estimate", () => {
  const summary = summarizeOutcomes(
    [
      { taskClass: "code.feature", outcome: outcome("completed", { usage: [usage("subscription", 2), usage("metered", 1)] }) },
      {
        taskClass: "code.feature",
        outcome: outcome("failed", { usage: [usage("metered", 0.5)], userOverride: { from: route, to: { ...route, model: "fake-2" } } }),
      },
      { taskClass: null, outcome: outcome("escalated", { usage: [usage("subscription", 0.25)] }) },
    ],
    baseline,
  );
  expect(summary.byClass).toEqual([
    { taskClass: "code.feature", tasks: 2, completed: 1, cost: { meteredUsd: 1.5, subscriptionUsd: 2 } },
    { taskClass: null, tasks: 1, completed: 0, cost: { meteredUsd: 0, subscriptionUsd: 0.25 } },
  ]);
  expect(summary.rates).toEqual({ tasks: 3, overridden: 1, escalated: 1 });
  // Each usage entry is 1M input ($5) + 0.1M output ($2.50) + 2M cache read ($1) at the baseline's list price: $8.50.
  expect(summary.savings).toMatchObject({ estimate: true, tasks: 3, completed: 1, actualUsd: 3.75, baselineUsd: 34 });
  expect(summary.savings.savedUsd).toBeCloseTo(30.25);
});

test("a period of n days starts at local midnight n - 1 days ago", () => {
  const now = new Date(2026, 8, 30, 15, 30);
  expect(periodStart(1, now)).toBe(new Date(2026, 8, 30).toISOString());
  expect(periodStart(7, now)).toBe(new Date(2026, 8, 24).toISOString());
  expect(periodStart(undefined, now)).toBeNull();
});
