# 0011 · A Claude Code turn ends when Claude Code goes idle

## Status

Accepted (issue #31, 2026-09-30).

## Context

Claude Code 2.1.285 can run the Agent tool in the background, even without `run_in_background`. The main agent's `result` then comes as soon as it stops. The subagent keeps working and its messages (tagged with `parent_tool_use_id`) arrive after that result. When it finishes, Claude Code answers it in a turn of its own, which ends in a second `result`. The adapter ended the Verdandi turn at the first result, so the subagent's steps and that answer landed in the thread's next turn, or nowhere.

A live check on Claude Code 2.1.285 with Agent SDK 0.3.272 showed:

- `task_started` (`task_type: local_agent`, `is_backgrounded: true`, `tool_use_id` = the Agent call) and `task_notification` bracket the subagent. A later move to the background arrives as `task_updated`.
- With `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, `session_state_changed: idle` comes only after the last result, once background agents are done and answered. A background Bash task doesn't hold it back: the process goes idle while it runs. The SDK calls it the authoritative turn-over signal. Without the variable, no state events are sent.
- Interrupt kills background agents (`task_notification: stopped`) because Verdandi doesn't declare `perTaskStopAffordance`. The process then goes idle with no result.

## Decision

1. The Verdandi turn stays open until its background subagents finish and Claude Code has answered them. The alternative, recording them as items attached to an ended turn, would need the decider to accept reports from turns that are over.
2. The adapter sets `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` and ends a turn at `idle`. It holds a success `turn.finished` from a result until then; usage from each result is reported as it comes. An error result still ends the turn at once.
3. A CLI that never reports `session_state_changed` keeps the old behavior: the turn ends at its last result.
4. `parentToolUseId` stays the link between a subagent's steps and the Agent call that started it. The task messages themselves aren't recorded.
5. Interrupt stops background subagents: Verdandi doesn't declare `perTaskStopAffordance`, so Claude Code kills them. The `idle` that follows ends the adapter's wind-down without waiting out its grace.

## Consequences

- The thread stays busy while a background subagent runs, and the user can steer or interrupt it as usual. A subagent that never finishes keeps the turn open until the user interrupts it.
- A restart can't leave a turn waiting. The Claude Code process ends with verdandid, and `turn.recover` ends the turn.
- `idle` doesn't wait for background shell tasks (`local_bash`): a dev server started in the background doesn't hold the turn. When one finishes, though, Claude Code answers it in a turn of its own, which the thread's next Verdandi turn reads as its first messages. That gap predates this decision. Closing it means matching results to the turn's prompt uuid (`user_message_uuids`).
- The native harness isn't built yet. When it is, it follows the same rule: a turn holds its subagents.
