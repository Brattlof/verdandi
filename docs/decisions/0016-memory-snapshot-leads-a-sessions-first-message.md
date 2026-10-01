# 0016 · The memory snapshot leads a session's first message

## Status

Accepted (issue #81, 2026-10-01).

## Context

DESIGN §14.2 adds a capped snapshot of what Verdandi remembers "to the prompt at session start", fixed for the session so the cache survives. On Claude Code the obvious place is the system prompt (`systemPrompt: { type: 'preset', preset: 'claude_code', append }`), but Verdandi passes no `systemPrompt` today, and switching to the preset only when there are memories could change the agent's whole system prompt between sessions with and without them. A process that resumes a session (after a restart, an interrupt, a budget guard or a revert's fork) would also have to be given the same text again.

## Decision

1. When a turn starts a new harness session (the thread has no session bound), the decider records `memory.snapshot.taken` with the snapshot: each store's most recently confirmed entries that fit its cap (user 1,500 characters, project 2,000), inside a `<verdandi-memory>` block marked as facts to weigh, not instructions. Nothing is recorded when memory is empty.
2. The harness gets it as `memory` on that turn only, and puts it at the head of the turn's message (Claude Code: a text block before the turn's own). From then on it is part of the session's history: a resumed or forked session already has it, and nothing about the session's prompt changes.
3. Saves during the session show from the next session on. `memory_search` sees them at once; its results are tool output in the conversation, never the system prompt.
4. Memory writes are events (`memory.saved`, `memory.edited`, `memory.deleted`). The decider scans every save and edit (secrets, with the trajectory redactor's patterns; instructions aimed at an agent; ways to send data out) and refuses one that would pass the store's cap, asking the agent to consolidate with `replaces`.

## Consequences

- The snapshot costs input tokens once per session, cached like the rest of the first message.
- A fact saved mid-session isn't in that session's snapshot, but `memory_search` finds it.
- If Verdandi later sets a system prompt for other reasons, the snapshot can move there; old sessions keep theirs in their history either way.
- `memory.yaml` in the Verdandi home (`approveSaves: true`) makes `memory_save` ask the user each time. It is read when verdandid starts, since a session's tool list is fixed.
