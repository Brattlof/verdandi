# 0029 · M3 escalation on real failures: not measurable yet

## Status

Accepted (issue #173, 2026-10-03).

## Context

M3's exit criterion (DESIGN §21) includes "escalation fixes more than half of first-attempt failures". ADR 0024's invented tasks all passed on their first attempt, so nothing escalated, and it named real failures (turns the user corrected or reverted) as the better source. Issue #173 assumed the developer's home already records them: task outcomes that failed, were reverted, overridden, corrected or rated down, each with its project, start checkpoint and first message. Its plan was to export those tasks as a draft `EvalSet`, pin each start checkpoint to a ref that outlives `gc`, and run the set on `auto`, now that #171 runs verifiers on every changed tree.

A copy of the developer's home (`~/.verdandi/profiles/default`: the database with its WAL, the only profile, no batch homes under it) was read read-only on 2026-10-03:

| table | rows |
|---|---|
| `effect_sql_migrations` | 20 (all applied 2026-10-01 20:21) |
| `events`, `threads`, `turns`, `tasks`, `task_outcomes`, `trajectories`, `decisions`, `route_decisions`, `projects` | 0 |

verdandid ran its migrations once, at its first start, and has recorded nothing since: the developer hasn't used Verdandi for real work yet.

## Decision

**The criterion stays unmeasured: the home holds no tasks, so there are 0 real first-attempt failures, short of the 10 the issue asks for.** Building the export and the durable ref now would mean tooling tested only on fixture homes, shaped around outcomes nobody has looked at, so neither is built until a home has the failures to export.

The run is worth doing once one home has at least 10 tasks that failed on their first attempt: status `failed`, `reverted` or `limit`, a `userOverride`, `implicitSatisfaction` below 1, or `rating` -1, on projects whose verifiers can grade them.

## Consequences

- **Live use measures most of it without a batch run.** A routed task whose first turn fails a verifier, calls `report_blocked`, repeats a tool error or is corrected escalates live, and its `TaskOutcome` keeps the `triggers`, the steps taken and how the task ended. The fix rate on those tasks can be read from `task_outcomes` (an escalated task that ended `completed` with its last verifier passing). The export-and-replay plan is still needed for the failures that never escalated: pinned threads, `@name` tasks, reverts, overrides and thumbs-down.
- **Checkpoints go after 30 days.** `gc` (ADR 0021) removes a task's start checkpoint once its turn is older than `keepDays`, unless it is one of an unarchived thread's last `keepTurns` turns or its first start checkpoint. Failures recorded from now on are replayable for about a month. The export should land within that window after real use starts, or `keepDays` should be raised in `gc.yaml` meanwhile.
- **The export's shape from #173 still holds:** a format on `verdandi trajectories export`, which already opens the database read-only and walks tasks, before a new command; `verify` left for the developer to write; and a ref outside `refs/verdandi/checkpoints/` that `gc` doesn't sweep, for `verdandi batch` to clone.
- **ADR 0024's caveat carries over.** A real failure's prompt was written for a session with history, so replaying the first message in a fresh clone is a harder task than the one that failed, and some will be ungradeable. The run should report how many drafts were dropped and why.
