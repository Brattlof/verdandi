import { expect, test } from "bun:test";
import type { UsageReport } from "@verdandi/contracts";
import { usageText } from "./costs.ts";

const report: UsageReport = {
  since: null,
  spend: { meteredUsd: 1.5, subscriptionUsd: 4 },
  daily: [{ day: "2026-09-30", meteredUsd: 1.5, subscriptionUsd: 4 }],
  quotas: [],
  byClass: [{ taskClass: "code.feature", tasks: 3, completed: 2, cost: { meteredUsd: 1.5, subscriptionUsd: 4 } }],
  byTarget: [
    { model: "sonnet", accessMode: "subscription", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 4 },
  ],
  rates: { tasks: 4, overridden: 1, escalated: 0 },
  savings: {
    estimate: true,
    baseline: "opus on claude-code at list price",
    tasks: 4,
    completed: 2,
    actualUsd: 5.5,
    baselineUsd: 11,
    savedUsd: 5.5,
  },
};

test("shows paid and on-plan spend apart, cost per completed task, and savings labelled as an estimate", () => {
  const text = usageText(report, "all time");
  expect(text).toContain("Spend all time: $1.5000 paid (metered), $4.0000 on plan");
  expect(text).toMatch(/code\.feature\s+3\s+2\s+\$1\.5000\s+\$4\.0000\s+\$0\.7500\s+\$2\.0000/);
  expect(text).toContain("Overridden by you: 1 of 4 tasks (25%)");
  expect(text).toContain("(an estimate: these tasks' recorded tokens priced at opus on claude-code at list price)");
  expect(text).toContain("saving $5.5000 (50% less)");
});
