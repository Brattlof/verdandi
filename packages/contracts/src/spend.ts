import { Schema } from "effect";
import type { HarnessId } from "./route.ts";
import type { QuotaView, ThreadSummary } from "./rpc.ts";

/** Who a spend cap covers: every project in the profile, or one project (DESIGN §8.9). */
export const CapScope = Schema.Literals(["profile", "project"]);
export type CapScope = typeof CapScope.Type;

/** A cap's period, in the user's local time: today, or this calendar month. */
export const CapPeriod = Schema.Literals(["day", "month"]);
export type CapPeriod = typeof CapPeriod.Type;

/**
 * A metered spend cap as it stands now. `baseUsd` is the configured cap and `limitUsd` the one in force,
 * higher when the user raised it for the rest of the period `periodKey` (`2026-09-30`, `2026-09`).
 * `spentUsd` counts metered usage only, extra usage on a subscription included.
 */
export const SpendCap = Schema.Struct({
  scope: CapScope,
  period: CapPeriod,
  periodKey: Schema.String,
  baseUsd: Schema.Number,
  limitUsd: Schema.Number,
  spentUsd: Schema.Number,
});
export type SpendCap = typeof SpendCap.Type;

const scopeNames: Record<CapScope, string> = { profile: "profile's", project: "project's" };
const periodNames: Record<CapPeriod, { readonly cap: string; readonly now: string }> = {
  day: { cap: "daily", now: "today" },
  month: { cap: "monthly", now: "this month" },
};

/** e.g. `project's daily cap` */
export const capName = (cap: Pick<SpendCap, "scope" | "period">) => `${scopeNames[cap.scope]} ${periodNames[cap.period].cap} cap`;
/** `today` or `this month` */
export const capPeriodNow = (period: CapPeriod) => periodNames[period].now;

/** A cap on one line, e.g. `project's daily cap: $1.20 of $5.00 spent today`. */
export const describeSpendCap = (cap: SpendCap) =>
  `${capName(cap)}: ${formatUsd(cap.spentUsd)} of ${formatUsd(cap.limitUsd)} spent ${capPeriodNow(cap.period)}${cap.limitUsd > cap.baseUsd ? ` (raised from ${formatUsd(cap.baseUsd)})` : ""}`;

/** Whether the cap stops new turns. */
export const capReached = (cap: SpendCap) => cap.spentUsd >= cap.limitUsd;

/** Dollars to the cent; a nonzero amount under half a cent shows as `<$0.01`. */
export const formatUsd = (usd: number) => (usd > 0 && usd < 0.005 ? "<$0.01" : `$${usd.toFixed(2)}`);

/** A thread's cost on one line, e.g. `$0.12 paid · $0.40 on plan`; empty when it has none. The two are never added up. */
export const describeCost = ({ meteredUsd, subscriptionUsd }: ThreadSummary["cost"]) =>
  [meteredUsd > 0 ? `${formatUsd(meteredUsd)} paid` : "", subscriptionUsd > 0 ? `${formatUsd(subscriptionUsd)} on plan` : ""]
    .filter(Boolean)
    .join(" · ");

const harnessNames: Record<HarnessId, string> = { "claude-code": "Claude Code", fake: "Fake harness" };
const windowNames: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
};

/**
 * A harness's subscription window on one line, e.g. `Claude Code: weekly plan nearly used up (81% used); resets Wed 15:00`.
 * `time` formats the reset time for the reader; a reset already past says the next turn will update it.
 */
export const describeQuota = ({ harness, quota }: QuotaView, time: (iso: string) => string, now = Date.now()) => {
  const window = quota.window && windowNames[quota.window] ? `${windowNames[quota.window]} ` : "";
  const used = quota.utilization === undefined ? "" : ` (${Math.round(quota.utilization * 100)}% used)`;
  const state = quota.usingOverage
    ? `${window}limit reached; running on extra usage, priced as metered`
    : {
        allowed: `${window}plan within limits${used}`,
        allowed_warning: `${window}plan nearly used up${used}`,
        rejected: `${window}limit reached; turns fail until it resets`,
      }[quota.status];
  const reset =
    quota.resetsAt === undefined
      ? ""
      : Date.parse(quota.resetsAt) <= now
        ? `; reset at ${time(quota.resetsAt)}, the next turn updates this`
        : `; resets ${time(quota.resetsAt)}`;
  return `${harnessNames[harness]}: ${state}${reset}`;
};
