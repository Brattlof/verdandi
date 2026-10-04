import type { JobSchedule } from "@verdandi/contracts";
import { localMinute } from "../cli/thread-list.ts";

/** The machine's IANA time zone, which a cron schedule is read in unless one is named. */
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const units: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * A job's schedule from what the user or agent wrote: "in 2h" (or 30m, 1d, 90 minutes) and an ISO time (an offset or
 * `Z` pins its zone, else it's local) are one-offs, anything else a cron expression or nickname read in `tz`. The
 * decider checks it: an expression that doesn't parse, or a time in the past, is refused naming the fix.
 */
export const parseWhen = (text: string, tz: string, now: Date): JobSchedule => {
  const when = text.trim();
  const after = /^in\s+(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)$/i.exec(when);
  if (after) {
    const [, count = "", unit = ""] = after;
    return { kind: "once", at: new Date(now.getTime() + Number(count) * (units[unit.charAt(0).toLowerCase()] ?? 0)).toISOString() };
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(when)) {
    const at = new Date(when);
    return { kind: "once", at: Number.isNaN(at.getTime()) ? when : at.toISOString() };
  }
  return { kind: "cron", cron: when, tz };
};

/** How a schedule reads in a line: the expression and its zone, or the one-off's local time. */
export const describeWhen = (schedule: JobSchedule) =>
  schedule.kind === "cron" ? `${schedule.cron} (${schedule.tz})` : `once at ${localMinute(schedule.at)}`;
