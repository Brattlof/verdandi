# 0032 · verdandid's scheduler claims each occurrence at most once and sends it as an ordinary turn

## Status

Accepted (issues #210 and #211, 2026-10-04).

## Context

`verdandi schedule` first registered OS jobs that call `verdandi run` (#209). That route has no catch-up after verdandid was down and no way for the agent to set up a job. DESIGN §15 plans a scheduler inside verdandid. Hermes's notes on its own read like an incident log: occurrences lost, a ticker that died, bursts of runs after the host slept. Its rule is "at most once per occurrence, every occurrence accounted for".

A scheduled run should behave like any other turn: routed, under the spend caps and task limits, verified, escalated, with its task's outcome recorded. It also needs a home for its events. A job belongs to a thread (DESIGN §15: a job the agent creates delivers to its own thread), and every event belongs to one stream.

## Decision

1. **Jobs are events on their owning thread's stream:** `schedule.created`, `.paused`, `.resumed` and `.removed`, projected into `schedules`. The owner is the thread that created the job: the agent's, through `cronjob`, or for `verdandi schedule add` the CLI's thread for the job's folder, created if there is none. Each owner event names the job, so the log and the thread read without a lookup. Commands that name a job carry the owner's id, which `SchedulesList` gives.
2. **One timer, in an always-on verdandid only.** `SchedulerLive` runs only in `verdandi start` (and later the desktop app), never in a verdandid a chat or `verdandi run` started in its own process; `server.json` says which (`alwaysOn`). It waits for the active job whose next run comes first, re-arms at boot and on every `schedule.*` event, and looks again at least each minute, so a host that slept or a clock that jumped is noticed. When it fires it dispatches `schedule.fire { jobId, scheduledInstant, runThreadId }`.
3. **At most once.** The engine gives the decider the time now (`EngineOptions.now`, so tests set it) and the job. The decider fires only the job's current next run and only once it is due; it records `schedule.occurrence.claimed` and moves the next run on in the same transaction, so a second fire of that occurrence decides to `[]`. `schedule_runs` is keyed by `(job_id, scheduled_instant)`, a backstop for a decider bug.
4. **Catch-up is pure** (`catchUp` in `src/schedule/catch-up.ts`): from the schedule, the occurrence due and the time now. Grace is half the gap to the next occurrence, clamped to 2 minutes–2 hours. Inside grace the occurrence runs once; past grace the missed ones collapse into one run, or are all skipped when the job sets `missed: skip`; a one-off more than 2 minutes late is retired. The next run is always the first occurrence after now, so a host that slept never fires in a burst. Skipped occurrences are recorded as one `schedule.occurrence.skipped` per firing, as a range (`from`–`until`) with its reason, so a long outage of a frequent job costs one event, not one per occurrence.
5. **A run is an ordinary turn.** Reacting to a claim, the reactor dispatches `schedule.run.start` (the run's own `thread.created`, `schedule.run.started`, and a worktree request when the job has one; the project folder or the workspace) and sends the job's `turn.send`. A refused turn is the run's result. The run ends when its task stops: the reactor queues a check behind the turn's fiber, so an escalation's follow-up turn keeps the run going, and reports `schedule.run.report` → `schedule.run.ended` with the last turn's status (`error` when a verifier failed on it). On start, runs a stopped verdandid left are ended, never started again.
6. **Unattended.** `schedule.run.started` marks the thread (`threads.schedule`) the way `review.started` marks a review's. The decider denies its approval, question, plan, skill and trust requests at once with the reason (ADR 0023), and a flagged context file stops its turn without asking. A job's limits narrow its task's (`tighter`). A run's thread can't create jobs.
7. **Guards** (#211). A job's pre-run script runs only from `<home>/scripts/`, before the run's thread exists, so `{"wakeAgent": false}` ends the run `skipped` with no thread and no model call. A job without `allowMetered` routes as under a reached cap (its "cap" is the job's $0 allowance), and a turn whose target's subscription window is used up records `schedule.occurrence.held` instead of starting; `schedule.release` (a quota report of a window that isn't used up, or the timer at the reset) sends the turn again, which is held again if the window still is. Runs end with one status of a closed set; `schedules.failures` counts `error` and `blocked_config` in a row, and the third disables the job with a notice on the owning thread's latest turn. A watchdog races each scheduled turn's harness stream and ends a turn with no harness event for its job's `watchdogMinutes` (default 10) as an error.
8. **The agent's tool takes no route.** `cronjob` (create, list, pause) asks first and has no route, model, effort or limit parameters, so an agent-made job runs on the router's pick under its project's policy, as Hermes keeps model and provider out of its scheduling tool.

## Consequences

- A job's runs and skips show on its owning thread as lines in the terminal chat; each run's thread says whose run it is. `verdandi schedule list` is the full view.
- A job needs `verdandi start` running. `verdandi schedule add` says so when none is; what a job misses meanwhile is caught up by the rules above when it starts.
- A run is counted at the occurrence it was claimed for, even when it started late or several occurrences collapsed into it.
- OS scheduler entries from #209 keep working until removed: `fire` stays, `list` shows them and `remove --os` takes them out.
- A held run sends its turn again from the start, its script included, so the agent gets the script's output as of then.
- A script's verdict reads its standard output alone; its error output only shows when it fails.
- Not yet: `schedule.updated` (edit a job in place), skills to load, `contextFrom`, and delivery to a channel, whose failures will be `delivery_failed` (DESIGN §15).
