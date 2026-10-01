# 0004 · Revert a Claude Code conversation by forking

## Status

Accepted (M0 spike 004, 2026-09-29).

## Context

Revert (DESIGN §13) must roll a thread back to an earlier turn: files through Verdandi's git checkpoints, the conversation through the harness. Appendix D asked whether resuming at a given message and `forkSession` can serve as the conversation half on Claude Code.

Spike 004 branched a 3-turn session at turn 2 on the installed Claude Code 2.1.284 through Agent SDK 0.3.272.

## Decision

1. Verdandi sets a `uuid` on every prompt it sends and stores it with the turn.
2. Reverting to turn N resumes with `resumeSessionAt` (the last chain entry of turn N), `forkSession: true`, and `resumeDropsTurn` (the uuid of turn N+1's prompt). The thread then points at the new session id.
3. The original session is never truncated; the old id stays on record, so the revert itself can be undone.
4. A thrown error starting `Resume rejected by --resume-drops-turn:` means the transcript holds turns Verdandi didn't see. The adapter keeps the evidence, does not retry the fork, and falls back to a plain resume with the user told why.

## Implementation (issue #79, 2026-10-01)

- The fork point is the `parentUuid` of the dropped turn's prompt entry in the session transcript, whose `uuid` is that turn's id, so it is the kept turn's last chain entry whatever kind it is. The adapter reads it from the transcript path `harness.session.bound` recorded; without it, or without that entry, it resumes plainly and adds a `notice` item saying the agent still remembers the reverted turns.
- The fork happens when the next turn runs: `thread.reverted` leaves a pending fork on the thread, and the session binding that turn reports (even to the same id, after a fallback) clears it.
- The guard refuses a range of several of Verdandi's own turns (checked live on Claude Code 2.1.x, 2026-10-01: "range contains a user entry not attributable to the declared turn"). So `resumeDropsTurn` is passed only when the revert drops one turn; dropping several forks unguarded, which could silently drop entries Verdandi never saw.

## Consequences

- The branch keeps turns 1..N; the original keeps everything (verified).
- A fork's first turn reads the shared prefix from cache (~18.5k read, ≤220 written), so revert does not cost a cold cache.
- Forked sessions start without Claude Code's file-undo history; file state is Verdandi's checkpoint's job.
- `forkSession(id, { upToMessageId })` as a standalone function gives the same branch without starting a turn; it is the choice when the fork should exist before the next prompt.
