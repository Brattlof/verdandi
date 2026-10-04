import type { JobSchedule, JobSpec } from "@verdandi/contracts";

const minute = 60_000;
/** How late a one-off may fire, and the least grace any job gets. */
export const oneOffGrace = 2 * minute;
const maxGrace = 120 * minute;

/** The occurrence after `from` (strictly), in the schedule's time zone, or null when there is none. Pure: no clock. */
export const occurrenceAfter = (schedule: JobSchedule, from: Date): Date | null => {
  if (schedule.kind === "once") {
    const at = new Date(schedule.at);
    return at > from ? at : null;
  }
  return Bun.cron.parse(schedule.cron, from, { tz: schedule.tz });
};

/**
 * Why `schedule` can't make a job created at `now`, naming the fix; undefined when it can. A cron expression must
 * parse in its time zone and fire at least once in the next 8 years; a one-off must be a time, at most two minutes
 * past.
 */
export const scheduleProblem = (schedule: JobSchedule, now: Date): string | undefined => {
  if (schedule.kind === "once") {
    const at = new Date(schedule.at);
    if (Number.isNaN(at.getTime())) return `"${schedule.at}" isn't a time. Give an ISO time, e.g. 2026-10-05T07:00:00+02:00.`;
    return now.getTime() - at.getTime() > oneOffGrace ? `${schedule.at} is in the past. Pick a time ahead.` : undefined;
  }
  try {
    if (occurrenceAfter(schedule, now)) return undefined;
    return `"${schedule.cron}" never fires (no date matches it in the next 8 years). Check its day and month.`;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return /time zone/i.test(why)
      ? `"${schedule.tz}" isn't a time zone (${why}). Give an IANA name, e.g. Europe/Stockholm or UTC.`
      : `"${schedule.cron}" isn't a cron expression (${why}). Give five fields, minute hour day month weekday, e.g. "0 2 * * *" for 2:00 every night, or a nickname such as @daily.`;
  }
};

/** Half the gap after `due` to the next occurrence, clamped to 2 minutes–2 hours: how late an occurrence may still run. */
export const graceAfter = (due: Date, after: Date | null) =>
  after === null ? oneOffGrace : Math.min(maxGrace, Math.max(oneOffGrace, (after.getTime() - due.getTime()) / 2));

export type Skipped = { readonly from: Date; readonly until: Date; readonly reason: string };

/**
 * What firing a job whose next run `due` has come does at `now` (DESIGN §15, ADR 0032): claim `due` for one run,
 * skip occurrences with a reason, or both; then the job waits for `next`, the first occurrence after `now` (null: it's
 * done). An occurrence inside its grace runs once. Past grace the missed ones collapse into one run, or are all skipped
 * when the job's `missed` says `skip`. A one-off past its grace is retired, never run. Never more than one run, however
 * long the host slept. Pure: `now` comes from the caller.
 */
export const catchUp = (
  schedule: JobSchedule,
  missed: JobSpec["missed"],
  due: Date,
  now: Date,
): { readonly claim?: Date; readonly skipped?: Skipped; readonly next: Date | null } => {
  const after = occurrenceAfter(schedule, due);
  const late = now.getTime() - due.getTime() > graceAfter(due, after);
  const next = occurrenceAfter(schedule, now);
  if (schedule.kind === "once" && late)
    return {
      skipped: {
        from: due,
        until: due,
        reason: "it was more than 2 minutes late, as verdandid wasn't running then; a one-off is retired, never run late",
      },
      next: null,
    };
  // Occurrences after `due` that also came while the job waited are accounted for, never run on their own.
  const passed = after !== null && after <= now;
  if (late && missed === "skip")
    return {
      skipped: {
        from: due,
        until: now,
        reason: "verdandid wasn't running, or the host slept, past the grace period, and the job skips missed runs",
      },
      next,
    };
  const reason = late
    ? "verdandid wasn't running, or the host slept, so they collapsed into one run"
    : "they came while that run was late, so they collapsed into it";
  return { claim: due, ...(passed && { skipped: { from: after, until: now, reason } }), next };
};
