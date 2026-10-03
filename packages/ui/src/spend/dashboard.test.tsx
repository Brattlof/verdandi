import { expect, test } from "bun:test";
import type { UsageReport } from "@verdandi/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { fillDays, UsageView } from "./dashboard.tsx";

const report: UsageReport = {
  since: new Date(2026, 8, 28).toISOString(),
  spend: { meteredUsd: 1.5, subscriptionUsd: 4 },
  daily: [
    { day: "2026-09-28", meteredUsd: 1.5, subscriptionUsd: 0 },
    { day: "2026-09-30", meteredUsd: 0, subscriptionUsd: 4 },
  ],
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
    baselineUsd: 22,
    savedUsd: 16.5,
  },
};
const today = new Date(2026, 8, 30, 12);

test("the chart has a slot for every day of the period, empty on days without usage", () => {
  expect(fillDays(report, today).map((d) => [d.day, d.meteredUsd, d.subscriptionUsd])).toEqual([
    ["2026-09-28", 1.5, 0],
    ["2026-09-29", 0, 0],
    ["2026-09-30", 0, 4],
  ]);
  expect(fillDays({ since: null, daily: [] }, today)).toEqual([]);
});

test("shows paid and on-plan spend apart, never added up, and labels the savings an estimate", () => {
  const html = renderToStaticMarkup(<UsageView report={report} today={today} />);
  expect(html).toMatch(/Paid<\/dt><dd[^>]*>\$1\.50</);
  expect(html).toMatch(/On plan<\/dt><dd[^>]*>\$4\.00</);
  expect(html).not.toMatch(/>\$5\.50</); // no tile shows the two summed
  expect(html).toContain("Saved vs always-Opus (estimate)");
  expect(html).toContain("75% less than $22.00");
  expect(html).toContain("$0.75"); // paid per completed code.feature task
});
