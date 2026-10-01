# 0003 · Claude Code approvals, questions, plans and steering

## Status

Accepted (M0 spike 003, 2026-09-29).

## Context

M1 needs approvals, plan mode and steering on the Claude Code harness (DESIGN §9.3, §21). Appendix D asked how `canUseTool`, `AskUserQuestion` and `ExitPlanMode` behave in the approval flow, and whether a running session can take a message (steer).

Spike 003 exercised each on the installed Claude Code 2.1.284 through Agent SDK 0.3.272, in streaming-input mode.

## Decision

The Claude Code adapter maps SDK mechanisms to Verdandi events and commands:

| Verdandi | SDK |
|---|---|
| Approval request | `canUseTool` for any tool; answer `allow` / `deny` |
| "Always allow" | return the callback's `suggestions` as `updatedPermissions` |
| User-input request | `canUseTool` for `AskUserQuestion`; answer `allow` with `updatedInput.answers` keyed by question text |
| Plan approval | `canUseTool` for `ExitPlanMode` (`plan`, `planFilePath`); allow leaves plan mode |
| Approve an edited plan | `allow` with `updatedInput.plan` set to the user's edit |
| Deny with feedback | neutral `deny`, plus the feedback as a user message with `priority: "next"` |
| Steer | user message without priority: lands at the next tool boundary of the running turn |
| Stop and send | user message with `priority: "now"`: aborts the running tool, starts a new turn |
| Stop | `q.interrupt()` |

The adapter holds exactly one iterator per session.

## Consequences

- A deny message reaches the model as an error tool_result, which the model rightly treats as untrusted. User feedback must travel as a user message; this matches the invariant that tool output is data, not instructions.
- Approval text is built from `toolName` and `input`; the SDK's `title` / `decisionReason` are often absent.
- Plan files live in `~/.claude/plans/`. Verdandi stores the plan text from the `ExitPlanMode` input and the path as a pointer.
- An edited plan needs nothing but `updatedInput.plan` (read in the code of Claude Code 2.1.272, bundled with Agent SDK 0.3.272, and 2.1.286; not run live). Claude Code reads the plan file into the `plan` it passes `canUseTool`, and drops an answer's `plan` that equals it, so a plain allow isn't an edit. A different `plan` it writes over the plan file, and the agent's tool result carries it as the approved plan, headed "Approved Plan (edited by user)". Verdandi doesn't touch the plan file.
- An interrupted turn ends with `error_during_execution`; the session stays usable, so Stop is not a one-way door.
- Exiting a `for await` over the `Query` closes the CLI process; the adapter must not do it.
