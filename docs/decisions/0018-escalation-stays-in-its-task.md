# 0018 · Escalation stays in its task, on the same harness

## Status

Accepted (2026-10-01).

## Context

DESIGN §8.7's escalation ladder raises effort, then "moves to a stronger target, which starts a new task with a handoff", then asks the user, at most one step per task without asking. The first trigger built is a project verifier failing after a turn that changed files (#72).

Two things decide what an escalation step is:

- **What it's measured as.** Routing memory (§8.8) should learn "this class on this route keeps escalating, so start stronger". A new task would record the stronger route as its start and the old task as finished, and the cost per completed task would credit the fix to the stronger route alone.
- **What the cache costs.** On Claude Code a model or effort change between turns resumes the same session and re-reads its context on the new model (ADR 0002), the same as a user's route change. A new task on a fresh session would re-read the project from scratch.

## Decision

1. An escalation step changes the route of the running task and doesn't start a new one. `task.escalated` records the step, the route before and after, and the turn Verdandi sends next, which hands the agent the failed verifier's output, fenced and marked as data.
2. A stronger model is chosen only on the task's own harness, so the session and its context carry over. Moving to another harness waits for routing across harnesses (M4).
3. The outcome's status is how the task ended, and `escalations` counts its steps. Routing memory counts a task with any escalation against the route it started on, so the `escalated` status isn't written.
4. Only routed tasks escalate. A pinned route is the user's choice, and a verifier failing on it is shown, not acted on.
5. A spend cap that is reached stops the ladder, and the step becomes `ask`.

## Consequences

- An escalation is one more turn in the thread, labelled as Verdandi's, and the route chip shows the new route. The user can still move the task's route themselves, which counts as an override as before.
- The effort step pays the cache re-read on Claude Code that ADR 0002 measured, which a task that is failing anyway is worth paying.
- The effort step goes to the next level the model takes (the catalog's `efforts`), and skips to the next step on a model with no higher level, or none (Haiku).
- The agent calling `report_blocked` escalates the same way, handing it its own report as data (#124). So does the same tool error coming back `escalation.repeatedErrors` times in the task (#125), handing it the error as data. Other triggers (a rejected diff or revert) aren't built.
- A rejected plan (#174) escalates inside the running turn, since the agent plans again right away: the step is committed before the denial and applied through the harness's `reroute`, as an approved plan's build is (ADR 0013). The effort step stays first on the ladder there too, applied mid-turn (Claude Code: `applyFlagSettings({ effortLevel })`; native: the next request's `output_config`). Waiting for the next turn would have the agent replan on the route the user just rejected, and skipping to the model step would pay more: an effort change rewrites the conversation's cache but keeps the system and tools prefix (ADR 0002), while a new model writes all of it. ADR 0002 measured effort changes between turns and ADR 0013 a model change inside one; an effort change inside a turn goes through the same control path, unmeasured.
- De-escalation after the verifiers pass (#127) follows this decision. It moves the running task down on its own harness, and the task stays one task.
