import { expect, test } from "bun:test";
import { type DatedCatalogEntry, Effort, type TaskId, type TaskOutcome, type ThreadId } from "@verdandi/contracts";
import { periodStart, summarizeOutcomes } from "./usage.ts";

const route = { harness: "fake", model: "fake", effort: "low" } as const;
const baseline: DatedCatalogEntry = {
  harness: "claude-code",
  provider: "claude-subscription",
  model: "opus",
  access: "subscription",
  tier: "L",
  context: 1_000_000,
  vision: true,
  efforts: Effort.literals,
  prices: [{ since: "2026-07-24", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
};
const startedAt = "2026-09-30T10:00:00.000Z";
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
  v: 4,
  taskId: crypto.randomUUID() as TaskId,
  threadId: "t1" as ThreadId,
  route,
  status,
  turns: 1,
  implicitSatisfaction: 0,
  verifierRuns: [],
  escalations: 0,
  triggers: [],
  fallbacks: 0,
  usage: [],
  wallMs: 0,
  ...extra,
});

test("costs by class keep metered and subscription apart, count failures, and price the Opus baseline as an estimate", () => {
  const summary = summarizeOutcomes(
    [
      { taskClass: "code.feature", startedAt, outcome: outcome("completed", { usage: [usage("subscription", 2), usage("metered", 1)] }) },
      {
        taskClass: "code.feature",
        startedAt,
        outcome: outcome("failed", { usage: [usage("metered", 0.5)], userOverride: { from: route, to: { ...route, model: "fake-2" } } }),
      },
      { taskClass: null, startedAt, outcome: outcome("escalated", { usage: [usage("subscription", 0.25)] }) },
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

test("a later price leaves a past task's savings as they were and prices a task started from its day", () => {
  const before = {
    taskClass: null,
    startedAt: "2026-09-21T23:59:00.000Z",
    outcome: outcome("completed", { usage: [usage("subscription", 1)] }),
  };
  const after = { ...before, startedAt: "2026-09-22T00:00:00.000Z" };
  const baselineUsd = (rows: (typeof before)[], b: DatedCatalogEntry) => summarizeOutcomes(rows, b).savings.baselineUsd;
  const repriced: DatedCatalogEntry = {
    ...baseline,
    prices: [...baseline.prices, { since: "2026-09-22", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
  };
  expect(baselineUsd([before], repriced)).toBe(baselineUsd([before], baseline));
  // 1M input ($4) + 0.1M output ($2) + 2M cache read ($0.40) at the price from 2026-09-22.
  expect(baselineUsd([after], repriced)).toBeCloseTo(6.4);
  // A task from before the oldest price has no earlier one: it gets the oldest.
  expect(baselineUsd([{ ...before, startedAt: "2026-01-01T00:00:00.000Z" }], repriced)).toBe(baselineUsd([before], baseline));
});

test("a period of n days starts at local midnight n - 1 days ago", () => {
  const now = new Date(2026, 8, 30, 15, 30);
  expect(periodStart(1, now)).toBe(new Date(2026, 8, 30).toISOString());
  expect(periodStart(7, now)).toBe(new Date(2026, 8, 24).toISOString());
  expect(periodStart(undefined, now)).toBeNull();
});
