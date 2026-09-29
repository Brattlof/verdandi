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

## Consequences

- The branch keeps turns 1..N; the original keeps everything (verified).
- A fork's first turn reads the shared prefix from cache (~18.5k read, ≤220 written), so revert does not cost a cold cache.
- Forked sessions start without Claude Code's file-undo history; file state is Verdandi's checkpoint's job.
- `forkSession(id, { upToMessageId })` as a standalone function gives the same branch without starting a turn; it is the choice when the fork should exist before the next prompt.
