import type { Event, ThreadView } from "@verdandi/contracts";
import { localMinute } from "../cli/thread-list.ts";
import { describeWhen } from "./when.ts";

type ScheduleEvent = Extract<Event, { type: `schedule.${string}` }>;

/**
 * The terminal chat's line for each job event on its owning thread (DESIGN §15): what the job did, with each run's
 * thread. A run's own thread says what it is in its banner (`runBanner`).
 */
const lines: { [T in ScheduleEvent["type"]]: (e: Extract<ScheduleEvent, { type: T }>) => string | undefined } = {
  "schedule.created": (e) =>
    `[scheduled ${e.job.name}, ${describeWhen(e.job.schedule)}${e.nextRunAt ? `, next at ${localMinute(e.nextRunAt)}` : ""}: its runs show here]`,
  "schedule.paused": (e) => `[paused ${e.name}]`,
  "schedule.resumed": (e) => `[resumed ${e.name}${e.nextRunAt ? `, next at ${localMinute(e.nextRunAt)}` : ""}]`,
  "schedule.removed": (e) => `[removed ${e.name}; its runs' threads stay]`,
  "schedule.occurrence.claimed": (e) =>
    `[${e.name} started its run due at ${localMinute(e.scheduledInstant)}: verdandi chat --thread ${e.runThreadId}]`,
  "schedule.occurrence.skipped": (e) =>
    `[${e.name} skipped ${e.from === e.until ? `its run due at ${localMinute(e.from)}` : `its runs from ${localMinute(e.from)} to ${localMinute(e.until)}`}: ${e.reason}]`,
  "schedule.run.started": () => undefined,
  "schedule.occurrence.held": (e) => `[${e.reason}]`,
  "schedule.occurrence.released": (e) => `[${e.name}'s run due at ${localMinute(e.scheduledInstant)} goes on: its window may have reset]`,
  "schedule.disabled": (e) => `[disabled ${e.name}: ${e.reason}. verdandi schedule resume ${e.name} enables it again]`,
  "schedule.run.ended": (e) =>
    `[${e.name}'s run due at ${localMinute(e.scheduledInstant)} ended ${e.status}${e.error ? `: ${e.error}` : e.output ? `: ${e.output.trimEnd()}` : ""}]`,
};

/** The chat's line for `e`, when it's a job event that has one. */
export const scheduleLine = (e: Event) =>
  e.type.startsWith("schedule.") ? (lines[e.type as ScheduleEvent["type"]] as (e: Event) => string | undefined)(e) : undefined;

/** What a run's thread says when the chat opens it. */
export const runBanner = ({ name, scheduledInstant }: NonNullable<ThreadView["schedule"]>) =>
  `This thread is ${name}'s scheduled run due at ${localMinute(scheduledInstant)}: Verdandi sent its turn, and denied whatever the agent asked, since nobody watched it.\n`;
