import {
  type DatedCatalogEntry,
  listCost,
  type SpendSplit,
  type TaskClass,
  type TaskOutcome,
  type Usage,
  type UsageFilter,
  type UsageReport,
} from "@verdandi/contracts";
import { datedCatalog, priceOn } from "@verdandi/router";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { loadQuotas } from "../event-store/projector.ts";

/**
 * What the savings estimate compares against: every task on Opus, at the list price of the day it started, so a later
 * price change or a move of the alias doesn't rewrite past savings (DESIGN §8.9, §8.10 baseline a).
 */
const alwaysOpus = datedCatalog.find((e) => e.harness === "claude-code" && e.model === "opus");
if (!alwaysOpus) throw new Error("The built-in model catalog has no Claude Code opus entry, which the savings estimate prices against.");

/** When a period of `days` local days, today included, began; null for all time. */
export const periodStart = (days: number | undefined, now: Date) =>
  days === undefined ? null : new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).toISOString();

/** Usage in USD kept apart by access mode: metered was paid, subscription is what the plan covered. */
export const spendSplit = (usage: readonly Usage[]): SpendSplit => ({
  meteredUsd: usage.reduce((sum, u) => sum + (u.accessMode === "metered" ? u.costUsd : 0), 0),
  subscriptionUsd: usage.reduce((sum, u) => sum + (u.accessMode === "subscription" ? u.costUsd : 0), 0),
});

/** Pure: cost per class, override and escalation counts, and the savings estimate, from the period's task outcomes. */
export const summarizeOutcomes = (
  rows: readonly { readonly taskClass: TaskClass | null; readonly startedAt: string; readonly outcome: TaskOutcome }[],
  baseline: DatedCatalogEntry,
): Pick<UsageReport, "byClass" | "rates" | "savings"> => {
  const classes = new Map<TaskClass | null, { tasks: number; completed: number; cost: SpendSplit }>();
  let overridden = 0;
  let escalated = 0;
  let completed = 0;
  let actualUsd = 0;
  let baselineUsd = 0;
  for (const { taskClass, startedAt, outcome } of rows) {
    const done = outcome.status === "completed";
    const cost = spendSplit(outcome.usage);
    const c = classes.get(taskClass) ?? { tasks: 0, completed: 0, cost: { meteredUsd: 0, subscriptionUsd: 0 } };
    classes.set(taskClass, {
      tasks: c.tasks + 1,
      completed: c.completed + (done ? 1 : 0),
      cost: { meteredUsd: c.cost.meteredUsd + cost.meteredUsd, subscriptionUsd: c.cost.subscriptionUsd + cost.subscriptionUsd },
    });
    if (outcome.userOverride) overridden++;
    if (outcome.escalations > 0 || outcome.status === "escalated") escalated++;
    if (done) completed++;
    const price = priceOn(baseline.prices, startedAt);
    for (const u of outcome.usage) {
      actualUsd += u.costUsd;
      baselineUsd += listCost(price, u);
    }
  }
  const spent = (c: SpendSplit) => c.meteredUsd + c.subscriptionUsd;
  return {
    byClass: [...classes]
      .map(([taskClass, c]) => ({ taskClass, ...c }))
      .toSorted((a, b) => spent(b.cost) - spent(a.cost) || String(a.taskClass).localeCompare(String(b.taskClass))),
    rates: { tasks: rows.length, overridden, escalated },
    savings: {
      estimate: true,
      baseline: `${baseline.model} on ${baseline.harness} at the list price of the day each task started`,
      tasks: rows.length,
      completed,
      actualUsd,
      baselineUsd,
      savedUsd: baselineUsd - actualUsd,
    },
  };
};

/** The spend dashboard's totals for `filter` as of `now` (DESIGN §8.9, §12). */
export const loadUsageReport = (filter: UsageFilter, now: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const since = periodStart(filter.days, now);
    const project = filter.projectId ?? null;
    const daily = yield* sql<{ day: string; metered_usd: number; subscription_usd: number }>`
      select date(u.at, 'localtime') as day,
        total(case when u.access_mode = 'metered' then u.cost_usd end) as metered_usd,
        total(case when u.access_mode = 'subscription' then u.cost_usd end) as subscription_usd
      from usage_ledger u join turns t on t.id = u.turn_id join threads h on h.id = t.thread_id
      where (${since} is null or u.at >= ${since}) and (${project} is null or h.project_id = ${project})
      group by 1 order by 1`;
    const byTarget = yield* sql<{
      model: string;
      access_mode: Usage["accessMode"];
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      cost_usd: number;
    }>`
      select u.model, u.access_mode, total(u.input_tokens) as input_tokens, total(u.output_tokens) as output_tokens,
        total(u.cache_read_tokens) as cache_read_tokens, total(u.cache_write_tokens) as cache_write_tokens, total(u.cost_usd) as cost_usd
      from usage_ledger u join turns t on t.id = u.turn_id join threads h on h.id = t.thread_id
      where (${since} is null or u.at >= ${since}) and (${project} is null or h.project_id = ${project})
      group by 1, 2 order by cost_usd desc, 1, 2`;
    const outcomes = yield* sql<{ task_class: TaskClass | null; started_at: string; payload: string }>`
      select d.task_class, k.started_at, o.payload
      from task_outcomes o join tasks k on k.id = o.task_id join threads h on h.id = k.thread_id
        left join route_decisions d on d.task_id = k.id
      where (${since} is null or k.started_at >= ${since}) and (${project} is null or h.project_id = ${project})
      order by k.seq`;
    const days = daily.map((d) => ({ day: d.day, meteredUsd: d.metered_usd, subscriptionUsd: d.subscription_usd }));
    return {
      since,
      spend: {
        meteredUsd: days.reduce((sum, d) => sum + d.meteredUsd, 0),
        subscriptionUsd: days.reduce((sum, d) => sum + d.subscriptionUsd, 0),
      },
      daily: days,
      quotas: yield* loadQuotas,
      byTarget: byTarget.map((t) => ({
        model: t.model,
        accessMode: t.access_mode,
        inputTokens: t.input_tokens,
        outputTokens: t.output_tokens,
        cacheReadTokens: t.cache_read_tokens,
        cacheWriteTokens: t.cache_write_tokens,
        costUsd: t.cost_usd,
      })),
      ...summarizeOutcomes(
        outcomes.map((o) => ({ taskClass: o.task_class, startedAt: o.started_at, outcome: JSON.parse(o.payload) as TaskOutcome })),
        alwaysOpus,
      ),
    } satisfies UsageReport;
  });
