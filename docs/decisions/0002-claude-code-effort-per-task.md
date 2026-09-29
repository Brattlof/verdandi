# 0002 · Claude Code effort is set per task, not per turn

## Status

Accepted (M0 spike 002, 2026-09-29).

## Context

DESIGN §8.7 plans per-turn auto effort: the router nudges effort down for light turns and up for heavy ones, but only "on harnesses that can change it mid-session without a cache miss". §8.2 listed effort's cache effect as "small, or none (verify for each harness)". Appendix D asked how effort is set through the SDK, whether it can change within a session, and what `setModel()` does.

Spike 002 measured this on the installed Claude Code 2.1.284 through Agent SDK 0.3.272, with Sonnet 5.5 and Haiku 4.5, reading per-turn cache reads and writes from `result.usage` and applied effort from a `Stop` hook.

## Decision

1. Effort for the Claude Code harness is set per task: the `effort` option at session start or on resume.
2. Per-turn auto effort does not ship for Claude Code.
3. A mid-task effort change (escalation step 1) uses `q.applyFlagSettings({ effortLevel })` and passes the switch-cost gate, priced as a cache write of the conversation so far.
4. A mid-task model change uses `q.setModel()` and is priced as a cold write of the new model's full prefix plus the conversation.
5. The applied effort is read from hook input (`effort.level`), not assumed from the request.

## Consequences

- Every effort change invalidated the message-level cache (4/4); the system+tools prefix survived. The cost grows with conversation length, so late-thread effort changes are expensive and early ones are cheap.
- `setModel()` keeps the transcript. The cache is per model: a switch back within the TTL reuses the old model's prefix.
- Models without effort (Haiku 4.5) ignore it silently; `max` and `xhigh` are only on some models. The catalog takes supported levels from `supportedModels()`.
- The native harness still decides auto effort per provider, with the same cache check (§8.7).
