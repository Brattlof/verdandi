# 0030 · A thread moving to another harness starts from a handoff summary

## Status

Accepted (issue #183, 2026-10-03).

## Context

A harness session belongs to one harness. When a thread's route moves to another one (a route pick, an `@name` pin, or a task the router sends elsewhere), the projector drops the session, and until now the next turn started a session that knew nothing of the thread. M4's exit criterion is a thread that hands off between Claude Code and native. DESIGN §8.2 lever 5 seeds the new session with a summary in fixed sections, written by a cheap auxiliary task (§9.7), with the old transcript left to `session_search`.

Background review (ADR 0023) already runs a hidden, routed, unattended one-turn task and counts its cost under its own class. A handoff needs the same, with one difference: the user's own turn waits for it.

## Decision

1. **When.** Before a turn runs, the reactor hands off when the thread has no session, the harness its latest session ran on (`threads.session_harness`, set when a session is bound and kept after a route change drops it; migration 29 fills it from the log) differs from the turn's, and no revert's fork is pending. Every way a thread changes harness goes through this one check, in both directions.
2. **A hidden routed task.** The reactor creates a handoff thread (`handoff.start`: `thread.created` and `handoff.started`) in the project and sends its one turn in ask mode, over a digest of the thread's turns before this one (the review's `taskDigest`, latest kept). The decider routes it as `aux.handoff` without asking the decision layer (built-in: Haiku at low effort, `maxCost` 0.1), so its cost shows under that class. `handoff.started` is stored in the same `threads.review` column as `review.started`, which already hides a thread from lists and search, gives it no Verdandi tools, checkpoints, verifiers, nudge or escalation, and denies its requests at once. The decider reads it as `aux`.
3. **Guards.** Spend caps apply as to any turn, and a harness whose subscription window is short is refused (`HandoffSkipped`), as for a review. Unlike a review, a handoff may spend metered dollars without opting in: the user's turn is waiting on it, and the policy prefers the subscription target.
4. **The summary.** The reply is untrusted text. Verdandi sorts it into the sections (*Goal, Constraints, Progress, Decisions, Files touched, Open issues, Next steps*; a missing one reads "None.", an unheaded reply is all Progress), and fills *Files touched* itself from the thread's checkpoints, start against end for each turn whose refs are kept, never from the model. It asks the decision layer's injection question about the summary; a hit is recorded as `injection.flagged` (source `handoff`) and the summary goes over under the warning.
5. **Delivery.** The summary is recorded on the waiting turn as a `handoff` item (from, to, summary), which the web UI shows folded and `verdandi chat` prints. The harness gets it as `HarnessRunInput.handoff` on that turn only, a `<verdandi-handoff>` block fenced as data, right after the memory snapshot at the head of the new session's first message (ADR 0016), so it stays fixed in the session's history and the cache rule holds.
6. **Failure.** If the handoff can't start (a cap, no route, short quota), its turn ends without a reply, or it takes over 5 minutes, the turn goes on without a summary and a `notice` says why.

## Consequences

- The first turn after a harness switch waits for one extra model call before its agent starts, with nothing on screen until the `handoff` item arrives.
- Every handoff leaves a hidden thread behind, like a review. Nothing lists them; one can be opened by id.
- An interrupt of the waiting turn leaves the handoff's turn running to its end, bounded by its `maxCost`.
- Threads whose latest session was dropped before migration 29 have `session_harness` filled from the log, so their next turn hands off too.
- Compression (DESIGN §16) can reuse `handoffSummary`'s sections when it lands.
