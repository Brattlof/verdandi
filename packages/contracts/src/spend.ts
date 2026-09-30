import type { HarnessId } from "./route.ts";
import type { QuotaView, ThreadSummary } from "./rpc.ts";

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
