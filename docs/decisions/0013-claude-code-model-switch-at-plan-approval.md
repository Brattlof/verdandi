# 0013 · Claude Code switches model at plan approval, inside the running turn

## Status

Accepted (spike, 2026-09-30).

## Context

The plan/execute split (DESIGN §8.2 lever 3, M2) plans on a stronger route and builds on the class's own route once the user approves the plan. On Claude Code the approval is `canUseTool` allowing `ExitPlanMode` (ADR 0003), and the build goes on in the same turn. A switch that waited for the next turn would leave the whole build on the planning model. ADR 0002 measured `setModel()` between turns only.

A spike on Claude Code through Agent SDK 0.3.272 ran a plan-mode turn on Sonnet. It awaited `q.setModel("haiku")` inside `canUseTool` before allowing `ExitPlanMode`, then read `message.model` on each assistant message and the result's `modelUsage`.

## Decision

1. The harness contract gets `reroute(threadId, route)`. Verdandi calls it just before `respond` allows the plan.
2. The Claude Code adapter starts `setModel` and `applyFlagSettings({ effortLevel })` on `reroute`, and every `canUseTool` answer waits for them. The switch lands before the agent's next step.
3. The decider commits `task.rerouted` right before the approval's `approval.resolved`, so the reactor reroutes before it answers.

## Consequences

- Every assistant message before the approval came from Sonnet, and every one after it from Haiku. The result's `modelUsage` listed both, so the usage ledger splits the turn by model without any change.
- The move is priced by the switch-cost gate as a cache write of the plan's context on the new model, like any model change (ADR 0002).
- Only the model switch was observed mid-turn. The effort change goes through the same control path, and ADR 0002 measured it between turns.
- In plan mode, a session started on Haiku answered on Sonnet (`init` reported Haiku). Claude Code seems to plan on a stronger model than Haiku, so a Haiku plan route isn't honoured as written. The built-in policy plans on Opus.
- A failed switch leaves the build on the plan's model. Its usage still records the real model, but Verdandi's route says otherwise until the next turn applies it again.
