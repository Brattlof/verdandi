import {
  describeQuota,
  formatUsd,
  type ProjectId,
  type ProjectSummary,
  type SpendSplit,
  type UsageFilter,
  type UsageReport,
} from "@verdandi/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { Plait } from "./art.tsx";
import type { Connection } from "./client.ts";
import { RuneText } from "./runes.tsx";

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
      <div className="mx-auto max-w-[1040px] px-5 py-10 sm:px-8 sm:py-14">
        <header className="mb-6 flex flex-wrap items-end gap-3">
          <div className="relative mr-auto">
            <p className="flex items-center gap-3 text-rune">
              <RuneText runes={["fehu"]} className="h-4" />
              <span className="eyebrow text-muted">Fehu · wealth</span>
            </p>
            <h1 className="mt-3 font-serif text-5xl leading-[0.95] font-bold tracking-tight uppercase sm:text-6xl">Spend</h1>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Project
            <select
              className="max-w-56 text-fg"
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
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Period
            <select
              className="text-fg"
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
          <button type="button" className="text-xs" onClick={() => setRefreshes((n) => n + 1)}>
            Refresh
          </button>
          {report && (
            <span className="text-xs text-muted">as of {report.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          )}
        </header>
        <Plait className="mb-8 text-rune" />
        {report ? (
          <UsageView report={report.report} today={report.at} />
        ) : (
          <p role="status" className="text-muted">
            Loading…
          </p>
        )}
      </div>
    </div>
  );
};

/** One total: a large figure under its label. `lead` puts it on the sky surface, as the figure that matters most. */
const Tile = ({ label, value, note, lead = false }: { label: string; value: string; note: string; lead?: boolean }) => (
  <div className={`flex flex-col border border-line px-5 py-4 ${lead ? "bg-user" : "bg-card"}`}>
    <dt className="eyebrow text-muted">{label}</dt>
    <dd className="mt-2 font-serif text-4xl leading-none font-semibold tabular-nums">{value}</dd>
    <dd className="mt-2 text-xs text-muted">{note}</dd>
  </div>
);

/** A titled card for one part of the report. */
const Panel = ({ id, title, legend, children }: { id: string; title: string; legend?: ReactNode; children: ReactNode }) => (
  <section aria-labelledby={id} className="mb-4 border border-line bg-card px-5 py-4">
    <div className="mb-3 flex flex-wrap items-baseline gap-3">
      <h2 id={id} className="mr-auto font-serif text-xl font-semibold">
        {title}
      </h2>
      {legend}
    </div>
    {children}
  </section>
);

/** The report itself, apart from fetching it. */
export const UsageView = ({ report, today }: { report: UsageReport; today: Date }) => {
  const { spend, savings, rates } = report;
  return (
    <>
      <dl aria-label="Totals" className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Paid" value={formatUsd(spend.meteredUsd)} note="metered usage, in real dollars" />
        <Tile label="On plan" value={formatUsd(spend.subscriptionUsd)} note="subscription usage, valued at API prices" />
        <Tile
          lead
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
      </dl>
      {report.quotas.length > 0 && (
        <section aria-label="Subscription windows" className="mb-4 flex flex-col gap-1 text-xs text-muted">
          {report.quotas.map((q) => (
            <p key={q.harness} className="flex items-center gap-2">
              <span aria-hidden className="size-1.5 rounded-full bg-muted" />
              {describeQuota(q, resetTime)}
            </p>
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
    <Panel
      id="spend-per-day"
      title="Spend per day"
      legend={series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5 text-xs text-muted">
          <span aria-hidden className={`inline-block size-2.5 rounded-sm ${s.className}`} />
          {s.label}
        </span>
      ))}
    >
      {days.length === 0 ? (
        <p className="text-xs text-muted">No usage in this period.</p>
      ) : (
        <>
          <div className="text-xs text-muted tabular-nums">{formatUsd(max)}</div>
          <div aria-hidden className="flex h-40 items-end gap-[2px] border-y border-line border-b-line-strong [border-top-style:dashed]">
            {days.map((d) => (
              <div
                key={d.day}
                title={`${dayLabel(d.day)}: ${formatUsd(d.meteredUsd)} paid, ${formatUsd(d.subscriptionUsd)} on plan`}
                className="flex h-full min-w-0 flex-1 items-end justify-center gap-[2px] hover:bg-hover"
              >
                {series.map((s) => (
                  <div key={s.key} className={`w-full max-w-3 rounded-t ${s.className}`} style={{ height: height(d[s.key]) }} />
                ))}
              </div>
            ))}
          </div>
          <div aria-hidden className="mt-1 flex gap-[2px] text-xs text-muted">
            {days.map((d, i) => (
              <div key={d.day} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
                {i % tick === 0 ? dayLabel(d.day) : ""}
              </div>
            ))}
          </div>
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-muted">Table</summary>
            <table className="mt-1 tabular-nums">
              <thead>
                <tr className="text-left text-muted">
                  <th className="pr-4 font-normal">Day</th>
                  <th className="pr-4 text-right font-normal">Paid</th>
                  <th className="px-3 text-right font-medium whitespace-nowrap">On plan</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.day}>
                    <td className="pr-4">{dayLabel(d.day)}</td>
                    <td className="pr-4 text-right">{formatUsd(d.meteredUsd)}</td>
                    <td className="px-3 text-right">{formatUsd(d.subscriptionUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </Panel>
  );
};

const ClassTable = ({ rows }: { rows: UsageReport["byClass"] }) => (
  <Panel id="per-class" title="Cost per completed task, by task class">
    {rows.length === 0 ? (
      <p className="text-xs text-muted">No tasks in this period.</p>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th className="py-1.5 pr-3 font-medium">Class</th>
              <th className="px-3 text-right font-medium whitespace-nowrap">Tasks</th>
              <th className="px-3 text-right font-medium whitespace-nowrap">Completed</th>
              <th className="px-3 text-right font-medium whitespace-nowrap">Paid per completed</th>
              <th className="px-3 text-right font-medium whitespace-nowrap">On plan per completed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.taskClass ?? ""} className="border-b border-line last:border-0">
                <td className="py-1.5 pr-3 font-mono">{r.taskClass ?? "before routing"}</td>
                <td className="px-3 text-right">{r.tasks}</td>
                <td className="px-3 text-right">{r.completed}</td>
                <td className="px-3 text-right" title={`${formatUsd(r.cost.meteredUsd)} paid over all ${r.tasks} tasks`}>
                  {perCompleted(r.cost.meteredUsd, r.completed)}
                </td>
                <td className="px-3 text-right" title={`${formatUsd(r.cost.subscriptionUsd)} on plan over all ${r.tasks} tasks`}>
                  {perCompleted(r.cost.subscriptionUsd, r.completed)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </Panel>
);

const tokensOf = (t: UsageReport["byTarget"][number]) => t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;

/** How usage splits across models: tokens as bars, coloured by access mode, with each one's cost as text. */
const TargetBars = ({ rows }: { rows: UsageReport["byTarget"] }) => {
  const max = Math.max(1, ...rows.map(tokensOf));
  return (
    <Panel id="per-target" title="Usage by model">
      {rows.length === 0 ? (
        <p className="text-xs text-muted">No usage in this period.</p>
      ) : (
        <ul className="text-xs">
          {rows.map((t) => (
            <li
              key={`${t.model}-${t.accessMode}`}
              className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 py-1 sm:grid-cols-[180px_1fr_220px]"
            >
              <span className="truncate font-mono">
                {t.model} · {t.accessMode === "metered" ? "paid" : "on plan"}
              </span>
              <span className="col-span-2 row-start-2 h-2.5 sm:col-span-1 sm:col-start-2 sm:row-start-1">
                <span
                  className={`block h-full rounded-r ${t.accessMode === "metered" ? "bg-paid" : "bg-plan"}`}
                  style={{ width: `max(2px, ${(tokensOf(t) / max) * 100}%)` }}
                />
              </span>
              <span className="col-start-2 row-start-1 text-right text-muted tabular-nums sm:col-start-3">
                {tokensOf(t).toLocaleString()} tokens · {formatUsd(t.costUsd)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
};
