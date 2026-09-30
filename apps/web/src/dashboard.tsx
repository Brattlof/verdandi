import {
  describeQuota,
  formatUsd,
  type ProjectId,
  type ProjectSummary,
  type SpendSplit,
  type UsageFilter,
  type UsageReport,
} from "@verdandi/contracts";
import { useEffect, useState } from "react";
import type { Connection } from "./client.ts";

const periods: { days: number | undefined; label: string }[] = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: undefined, label: "All time" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOf = (key: string) => {
  const [y = 0, m = 1, d = 1] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const dayLabel = (key: string) => dayOf(key).toLocaleDateString([], { month: "short", day: "numeric" });

/** Every local day from the period's start (or the first day with usage) to `today`, with no usage on days the report skips. */
export const fillDays = (report: Pick<UsageReport, "since" | "daily">, today: Date) => {
  const first = report.since ? dayKey(new Date(report.since)) : report.daily[0]?.day;
  if (!first) return [];
  const byDay = new Map(report.daily.map((d) => [d.day, d]));
  const days: { day: string; meteredUsd: number; subscriptionUsd: number }[] = [];
  for (let d = dayOf(first); dayKey(d) <= dayKey(today); d.setDate(d.getDate() + 1)) {
    const key = dayKey(d);
    days.push(byDay.get(key) ?? { day: key, meteredUsd: 0, subscriptionUsd: 0 });
  }
  return days;
};

const resetTime = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
const percent = (part: number, whole: number) => (whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`);
const perCompleted = (usd: number, completed: number) => (completed === 0 ? "–" : formatUsd(usd / completed));

/**
 * The spend dashboard (DESIGN §8.9, §12): real spend and plan use kept apart, quota windows, cost per
 * completed task by class, usage by model, override and escalation rates, and savings against always-Opus,
 * labelled as an estimate. Fetched when opened, when a filter changes, and on Refresh; it never polls.
 */
export const Dashboard = ({ connection, projects }: { connection: Connection; projects: readonly ProjectSummary[] }) => {
  const [filter, setFilter] = useState<UsageFilter>({ days: 30 });
  const [refreshes, setRefreshes] = useState(0);
  const [report, setReport] = useState<{ readonly report: UsageReport; readonly at: Date }>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `refreshes` is the Refresh button's trigger, not an input.
  useEffect(() => {
    let current = true;
    void connection.usage(filter).then((r) => current && r && setReport({ report: r, at: new Date() }));
    return () => {
      current = false;
    };
  }, [connection, filter, refreshes]);
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[960px] px-4 py-3">
        <header className="mb-3 flex flex-wrap items-center gap-3">
          <h1 className="mr-auto text-base font-bold">Spend</h1>
          <label className="text-xs text-muted">
            Project{" "}
            <select
              value={filter.projectId ?? ""}
              onChange={(e) => {
                const { projectId: _, ...rest } = filter;
                setFilter(e.target.value ? { ...rest, projectId: e.target.value as ProjectId } : rest);
              }}
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.path}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted">
            Period{" "}
            <select
              value={filter.days ?? ""}
              onChange={(e) => {
                const { days: _, ...rest } = filter;
                setFilter(e.target.value ? { ...rest, days: Number(e.target.value) } : rest);
              }}
            >
              {periods.map((p) => (
                <option key={p.label} value={p.days ?? ""}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="px-2 py-0 text-xs" onClick={() => setRefreshes((n) => n + 1)}>
            Refresh
          </button>
          {report && (
            <span className="text-xs text-muted">as of {report.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          )}
        </header>
        {report ? <UsageView report={report.report} today={report.at} /> : <p className="text-muted">Loading…</p>}
      </div>
    </div>
  );
};

const Tile = ({ label, value, note }: { label: string; value: string; note: string }) => (
  <div className="min-w-[160px] flex-1 rounded-md border border-line px-3 py-2">
    <div className="text-xs text-muted">{label}</div>
    <div className="text-xl">{value}</div>
    <div className="text-xs text-muted">{note}</div>
  </div>
);

/** The report itself, apart from fetching it. */
export const UsageView = ({ report, today }: { report: UsageReport; today: Date }) => {
  const { spend, savings, rates } = report;
  return (
    <>
      <section aria-label="Totals" className="mb-4 flex flex-wrap gap-2">
        <Tile label="Paid" value={formatUsd(spend.meteredUsd)} note="metered usage, in real dollars" />
        <Tile label="On plan" value={formatUsd(spend.subscriptionUsd)} note="subscription usage, valued at API prices" />
        <Tile
          label="Saved vs always-Opus (estimate)"
          value={savings.tasks === 0 ? "–" : `${savings.savedUsd < 0 ? "−" : ""}${formatUsd(Math.abs(savings.savedUsd))}`}
          note={
            savings.tasks === 0
              ? "no tasks in this period"
              : `${percent(Math.abs(savings.savedUsd), savings.baselineUsd)} ${savings.savedUsd < 0 ? "more" : "less"} than ${formatUsd(savings.baselineUsd)}, these tasks' tokens at ${savings.baseline}`
          }
        />
        <Tile
          label="Overridden by you"
          value={percent(rates.overridden, rates.tasks)}
          note={`${rates.overridden} of ${rates.tasks} tasks; ${rates.escalated} escalated (${percent(rates.escalated, rates.tasks)})`}
        />
      </section>
      {report.quotas.length > 0 && (
        <section aria-label="Subscription windows" className="mb-4 text-xs text-muted">
          {report.quotas.map((q) => (
            <p key={q.harness}>{describeQuota(q, resetTime)}</p>
          ))}
        </section>
      )}
      <SpendChart days={fillDays(report, today)} />
      <ClassTable rows={report.byClass} />
      <TargetBars rows={report.byTarget} />
    </>
  );
};

const series: { key: keyof SpendSplit; label: string; className: string }[] = [
  { key: "subscriptionUsd", label: "On plan (subscription)", className: "bg-plan" },
  { key: "meteredUsd", label: "Paid (metered)", className: "bg-paid" },
];

/** Spend per day, subscription and metered side by side: two series on one dollar scale, never stacked, since they never add up. */
const SpendChart = ({ days }: { days: readonly { day: string; meteredUsd: number; subscriptionUsd: number }[] }) => {
  const max = Math.max(0, ...days.flatMap((d) => [d.meteredUsd, d.subscriptionUsd]));
  const height = (usd: number) => (usd > 0 ? `max(2px, ${(usd / max) * 100}%)` : "0");
  const tick = Math.max(1, Math.ceil(days.length / 8));
  return (
    <section aria-labelledby="spend-per-day" className="mb-5">
      <div className="mb-1 flex flex-wrap items-baseline gap-3">
        <h2 id="spend-per-day" className="mr-auto text-sm font-bold">
          Spend per day
        </h2>
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1 text-xs text-muted">
            <span aria-hidden className={`inline-block size-2.5 rounded-sm ${s.className}`} />
            {s.label}
          </span>
        ))}
      </div>
      {days.length === 0 ? (
        <p className="text-xs text-muted">No usage in this period.</p>
      ) : (
        <>
          <div className="text-xs text-muted">{formatUsd(max)}</div>
          <div aria-hidden className="flex h-36 items-end gap-[2px] border-t border-b border-line border-t-line/50">
            {days.map((d) => (
              <div
                key={d.day}
                title={`${dayLabel(d.day)}: ${formatUsd(d.meteredUsd)} paid, ${formatUsd(d.subscriptionUsd)} on plan`}
                className="flex h-full min-w-0 flex-1 items-end justify-center gap-[2px] hover:bg-line/40"
              >
                {series.map((s) => (
                  <div key={s.key} className={`w-full max-w-3 rounded-t ${s.className}`} style={{ height: height(d[s.key]) }} />
                ))}
              </div>
            ))}
          </div>
          <div aria-hidden className="flex gap-[2px] text-xs text-muted">
            {days.map((d, i) => (
              <div key={d.day} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
                {i % tick === 0 ? dayLabel(d.day) : ""}
              </div>
            ))}
          </div>
          <details className="mt-1 text-xs">
            <summary className="cursor-pointer text-muted">Table</summary>
            <table className="mt-1">
              <thead>
                <tr className="text-left text-muted">
                  <th className="pr-4 font-normal">Day</th>
                  <th className="pr-4 text-right font-normal">Paid</th>
                  <th className="text-right font-normal">On plan</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.day}>
                    <td className="pr-4">{dayLabel(d.day)}</td>
                    <td className="pr-4 text-right">{formatUsd(d.meteredUsd)}</td>
                    <td className="text-right">{formatUsd(d.subscriptionUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </section>
  );
};

const ClassTable = ({ rows }: { rows: UsageReport["byClass"] }) => (
  <section aria-labelledby="per-class" className="mb-5">
    <h2 id="per-class" className="mb-1 text-sm font-bold">
      Cost per completed task, by task class
    </h2>
    {rows.length === 0 ? (
      <p className="text-xs text-muted">No tasks in this period.</p>
    ) : (
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="py-1 font-normal">Class</th>
            <th className="text-right font-normal">Tasks</th>
            <th className="text-right font-normal">Completed</th>
            <th className="text-right font-normal">Paid per completed</th>
            <th className="text-right font-normal">On plan per completed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.taskClass ?? ""} className="border-b border-line/50">
              <td className="py-1">{r.taskClass ?? "before routing"}</td>
              <td className="text-right">{r.tasks}</td>
              <td className="text-right">{r.completed}</td>
              <td className="text-right" title={`${formatUsd(r.cost.meteredUsd)} paid over all ${r.tasks} tasks`}>
                {perCompleted(r.cost.meteredUsd, r.completed)}
              </td>
              <td className="text-right" title={`${formatUsd(r.cost.subscriptionUsd)} on plan over all ${r.tasks} tasks`}>
                {perCompleted(r.cost.subscriptionUsd, r.completed)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </section>
);

const tokensOf = (t: UsageReport["byTarget"][number]) => t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;

/** How usage splits across models: tokens as bars, coloured by access mode, with each one's cost as text. */
const TargetBars = ({ rows }: { rows: UsageReport["byTarget"] }) => {
  const max = Math.max(1, ...rows.map(tokensOf));
  return (
    <section aria-labelledby="per-target" className="mb-5">
      <h2 id="per-target" className="mb-1 text-sm font-bold">
        Usage by model
      </h2>
      {rows.length === 0 ? (
        <p className="text-xs text-muted">No usage in this period.</p>
      ) : (
        <ul className="text-xs">
          {rows.map((t) => (
            <li key={`${t.model}-${t.accessMode}`} className="grid grid-cols-[160px_1fr_200px] items-center gap-2 py-0.5">
              <span className="truncate">
                {t.model} · {t.accessMode === "metered" ? "paid" : "on plan"}
              </span>
              <span className="h-3">
                <span
                  className={`block h-full rounded-r ${t.accessMode === "metered" ? "bg-paid" : "bg-plan"}`}
                  style={{ width: `max(2px, ${(tokensOf(t) / max) * 100}%)` }}
                />
              </span>
              <span className="text-right text-muted">
                {tokensOf(t).toLocaleString()} tokens · {formatUsd(t.costUsd)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
