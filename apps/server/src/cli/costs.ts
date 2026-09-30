import { describeQuota, type RouteCost, type SpendSplit, type UsageFilter, type UsageReport } from "@verdandi/contracts";
import { Effect } from "effect";
import { flag, readServerFile, resolveHome } from "../config/home.ts";
import { projectIdFor } from "../orchestration/decider.ts";
import { connect } from "../rpc/client.ts";
import { resolveProjectPath } from "../workspace/project.ts";

const usd = (n: number | null) => (n === null ? "-" : `$${n.toFixed(4)}`);
const percent = (part: number, whole: number) => (whole === 0 ? "-" : `${Math.round((part / whole) * 100)}%`);

/** Rows in aligned columns, the first row being the header. */
const columns = (lines: readonly (readonly string[])[]) => {
  const widths = lines[0]?.map((_, i) => Math.max(...lines.map((l) => l[i]?.length ?? 0))) ?? [];
  return lines
    .map(
      (l) =>
        `${l
          .map((cell, i) => cell.padEnd(widths[i] ?? 0))
          .join("  ")
          .trimEnd()}\n`,
    )
    .join("");
};

/** One line per route, in aligned columns. */
export const costTable = (rows: readonly RouteCost[]) => {
  if (rows.length === 0) return "No task outcomes yet. A task's outcome is recorded when its turns finish.\n";
  return columns([
    ["route", "tasks", "completed", "cost", "per completed"],
    ...rows.map((r) => [
      `${r.route.harness} ${r.route.model} ${r.route.effort}`,
      String(r.tasks),
      String(r.completed),
      usd(r.costUsd),
      usd(r.costPerCompletedUsd),
    ]),
  ]);
};

/** Metered and subscription figures side by side, never added up. */
const paidAndPlan = (s: SpendSplit, per = 1) => [usd(per ? s.meteredUsd / per : null), usd(per ? s.subscriptionUsd / per : null)];

const resetTime = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** The spend dashboard's totals as text: spend, cost per completed task by class, usage by target, rates and the savings estimate. */
export const usageText = (report: UsageReport, period: string) => {
  const { spend, byClass, byTarget, rates, savings } = report;
  const out = [
    `Spend ${period}: ${usd(spend.meteredUsd)} paid (metered), ${usd(spend.subscriptionUsd)} on plan (subscription, at API prices)\n`,
    ...report.quotas.map((q) => `${describeQuota(q, resetTime)}\n`),
  ];
  if (byClass.length > 0) {
    out.push(
      "\n",
      columns([
        ["task class", "tasks", "completed", "paid", "on plan", "paid per completed", "on plan per completed"],
        ...byClass.map((c) => [
          c.taskClass ?? "(before routing)",
          String(c.tasks),
          String(c.completed),
          ...paidAndPlan(c.cost),
          ...paidAndPlan(c.cost, c.completed),
        ]),
      ]),
    );
  }
  if (byTarget.length > 0) {
    out.push(
      "\n",
      columns([
        ["model", "access", "input", "output", "cache read", "cache write", "cost"],
        ...byTarget.map((t) => [
          t.model,
          t.accessMode,
          String(t.inputTokens),
          String(t.outputTokens),
          String(t.cacheReadTokens),
          String(t.cacheWriteTokens),
          usd(t.costUsd),
        ]),
      ]),
    );
  }
  out.push(
    "\n",
    `Overridden by you: ${rates.overridden} of ${rates.tasks} tasks (${percent(rates.overridden, rates.tasks)}); escalated: ${rates.escalated} (${percent(rates.escalated, rates.tasks)})\n`,
    savings.tasks === 0
      ? "Savings vs always-Opus: no tasks in this period yet.\n"
      : `Savings vs always-Opus (an estimate: these tasks' recorded tokens priced at ${savings.baseline}): ${usd(savings.actualUsd)} recorded vs ${usd(savings.baselineUsd)}, ${savings.savedUsd >= 0 ? "saving" : "costing"} ${usd(Math.abs(savings.savedUsd))} (${percent(Math.abs(savings.savedUsd), savings.baselineUsd)} ${savings.savedUsd >= 0 ? "less" : "more"})\n`,
  );
  return out.join("");
};

/**
 * `verdandi costs`: cost per completed task on each route, then the spend dashboard's totals, for every
 * project or `--project <path>`, over all time or the last `--days <n>` days. A failed task's cost counts.
 */
export const costs = async (argv: readonly string[]) => {
  const server = readServerFile(resolveHome(argv));
  const days = flag(argv, "--days");
  if (days !== undefined && !/^[1-9]\d*$/.test(days)) throw new Error(`--days takes a whole number of days, e.g. --days 7; not "${days}".`);
  const project = flag(argv, "--project");
  const filter: UsageFilter = {
    ...(days === undefined ? {} : { days: Number(days) }),
    ...(project === undefined ? {} : { projectId: projectIdFor(await Effect.runPromise(resolveProjectPath(project))) }),
  };
  const [rows, report] = await Effect.runPromise(
    Effect.scoped(Effect.flatMap(connect(server), (client) => Effect.all([client.TaskCostsList(), client.UsageQuery(filter)]))),
  );
  const period = `${days === undefined ? "all time" : days === "1" ? "today" : `in the last ${days} days`}${project === undefined ? "" : ` in ${project}`}`;
  const byRoute = days === undefined && project === undefined ? "" : "By route, over all time and every project:\n";
  process.stdout.write(`${byRoute}${costTable(rows)}\n${usageText(report, period)}`);
};
