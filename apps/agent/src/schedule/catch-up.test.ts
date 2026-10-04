import { expect, test } from "bun:test";
import type { JobSchedule, JobSpec } from "@verdandi/contracts";
import { catchUp, scheduleProblem } from "./catch-up.ts";

const nightly: JobSchedule = { kind: "cron", cron: "0 2 * * *", tz: "Europe/Stockholm" }; // 00:00Z in summer time
const everyMinute: JobSchedule = { kind: "cron", cron: "* * * * *", tz: "UTC" };
const everyFive: JobSchedule = { kind: "cron", cron: "*/5 * * * *", tz: "UTC" };
const weekly: JobSchedule = { kind: "cron", cron: "0 9 * * MON", tz: "UTC" };
const once: JobSchedule = { kind: "once", at: "2026-10-05T07:00:00.000Z" };

/** `catchUp` with ISO strings in and out, so each golden case reads as times. */
const fire = (schedule: JobSchedule, due: string, now: string, missed: JobSpec["missed"] = "run") => {
  const r = catchUp(schedule, missed, new Date(due), new Date(now));
  return {
    claim: r.claim?.toISOString(),
    skipped: r.skipped && { from: r.skipped.from.toISOString(), until: r.skipped.until.toISOString() },
    next: r.next?.toISOString() ?? null,
  };
};

test.each([
  [
    "on time",
    nightly,
    "2026-10-05T00:00:00.000Z",
    "2026-10-05T00:00:05.000Z",
    "run",
    {
      claim: "2026-10-05T00:00:00.000Z",
      next: "2026-10-06T00:00:00.000Z",
    },
  ],
  // A day's period gives the most grace, 2 hours.
  [
    "late inside grace",
    nightly,
    "2026-10-05T00:00:00.000Z",
    "2026-10-05T01:30:00.000Z",
    "run",
    {
      claim: "2026-10-05T00:00:00.000Z",
      next: "2026-10-06T00:00:00.000Z",
    },
  ],
  [
    "one missed past grace runs once",
    nightly,
    "2026-10-05T00:00:00.000Z",
    "2026-10-05T03:00:00.000Z",
    "run",
    {
      claim: "2026-10-05T00:00:00.000Z",
      next: "2026-10-06T00:00:00.000Z",
    },
  ],
  [
    "one missed past grace, skipping missed runs",
    nightly,
    "2026-10-05T00:00:00.000Z",
    "2026-10-05T03:00:00.000Z",
    "skip",
    {
      skipped: { from: "2026-10-05T00:00:00.000Z", until: "2026-10-05T03:00:00.000Z" },
      next: "2026-10-06T00:00:00.000Z",
    },
  ],
  // A host that slept three days runs the job once, never three times.
  [
    "slept for days",
    nightly,
    "2026-10-05T00:00:00.000Z",
    "2026-10-08T01:00:00.000Z",
    "run",
    {
      claim: "2026-10-05T00:00:00.000Z",
      skipped: { from: "2026-10-06T00:00:00.000Z", until: "2026-10-08T01:00:00.000Z" },
      next: "2026-10-09T00:00:00.000Z",
    },
  ],
  [
    "slept for days, skipping missed runs",
    nightly,
    "2026-10-05T00:00:00.000Z",
    "2026-10-08T01:00:00.000Z",
    "skip",
    {
      skipped: { from: "2026-10-05T00:00:00.000Z", until: "2026-10-08T01:00:00.000Z" },
      next: "2026-10-09T00:00:00.000Z",
    },
  ],
  // Grace is half the period, 150 s here: 3 minutes late is past it, and the next occurrence hasn't come yet.
  [
    "half the period",
    everyFive,
    "2026-10-05T10:00:00.000Z",
    "2026-10-05T10:03:00.000Z",
    "skip",
    {
      skipped: { from: "2026-10-05T10:00:00.000Z", until: "2026-10-05T10:03:00.000Z" },
      next: "2026-10-05T10:05:00.000Z",
    },
  ],
  // Grace is at least 120 s, longer than a 1-minute period: the occurrence that came meanwhile collapses into the run.
  [
    "at least two minutes",
    everyMinute,
    "2026-10-05T10:00:00.000Z",
    "2026-10-05T10:01:40.000Z",
    "skip",
    {
      claim: "2026-10-05T10:00:00.000Z",
      skipped: { from: "2026-10-05T10:01:00.000Z", until: "2026-10-05T10:01:40.000Z" },
      next: "2026-10-05T10:02:00.000Z",
    },
  ],
  // A week's period would give 3.5 days; grace stops at 2 hours.
  [
    "at most two hours",
    weekly,
    "2026-10-05T09:00:00.000Z",
    "2026-10-05T11:30:00.000Z",
    "skip",
    {
      skipped: { from: "2026-10-05T09:00:00.000Z", until: "2026-10-05T11:30:00.000Z" },
      next: "2026-10-12T09:00:00.000Z",
    },
  ],
  [
    "a one-off inside 120 s",
    once,
    "2026-10-05T07:00:00.000Z",
    "2026-10-05T07:01:30.000Z",
    "run",
    {
      claim: "2026-10-05T07:00:00.000Z",
      next: null,
    },
  ],
  [
    "a one-off more than 120 s late is retired",
    once,
    "2026-10-05T07:00:00.000Z",
    "2026-10-05T07:02:01.000Z",
    "run",
    {
      skipped: { from: "2026-10-05T07:00:00.000Z", until: "2026-10-05T07:00:00.000Z" },
      next: null,
    },
  ],
] as const)("%s", (_, schedule, due, now, missed, expected) => {
  expect(fire(schedule, due, now, missed)).toEqual({ claim: undefined, skipped: undefined, ...expected });
});

test("a schedule that can't make a job names the fix", () => {
  const now = new Date("2026-10-05T07:00:00.000Z");
  expect(scheduleProblem(nightly, now)).toBeUndefined();
  expect(scheduleProblem({ kind: "cron", cron: "every night", tz: "UTC" }, now)).toContain("isn't a cron expression");
  expect(scheduleProblem({ kind: "cron", cron: "0 0 30 2 *", tz: "UTC" }, now)).toContain("never fires");
  expect(scheduleProblem({ kind: "cron", cron: "@daily", tz: "Mars/Olympus" }, now)).toContain("isn't a time zone");
  expect(scheduleProblem({ kind: "once", at: "tomorrow" }, now)).toContain("isn't a time");
  expect(scheduleProblem({ kind: "once", at: "2026-10-05T06:50:00.000Z" }, now)).toContain("is in the past");
  expect(scheduleProblem({ kind: "once", at: "2026-10-05T06:59:00.000Z" }, now)).toBeUndefined();
});
