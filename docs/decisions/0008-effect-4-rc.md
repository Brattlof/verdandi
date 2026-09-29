# 0008 · Effect 4 RC, not Effect 3

## Status

Accepted (M0 spike 008, 2026-09-29; owner sign-off the same day). Settles open question 2.

## Context

goldiloopd is built on Effect with RPC over a local WebSocket, SQL on `bun:sqlite`, and Streams (DESIGN §6, §19). Effect 4 is a release candidate; Effect 3 is stable but a later migration to 4 would touch every service. Appendix D asked how stable Effect 4 RC is on `@effect/platform-bun` for RPC over WebSocket, SQL and Stream.

Spike 008 ran `4.0.0-rc.115` (the newest version at least 14 days old) on Bun 1.3.14 / Windows 11: a separate server process with an RPC group backed by SQLite + FTS5, and a client measuring latency, throughput, streaming, early stream stop and reconnect.

## Decision

1. goldiloopd uses Effect 4, pinned to an exact RC and upgraded deliberately.
2. Until an Effect release passes the spike's `hol3.ts` check, clients never stop a server stream early on a shared connection. Live feeds are subscriptions ended by an explicit unsubscribe RPC; finite streams are read to the end.
3. Every Effect upgrade re-runs the early-stop check; when it passes, rule 2 is dropped.

## Consequences

- RPC, SQL, FTS5 and streaming work: unary p50 3.3 ms with a SQLite transaction, 100k streamed events in 0.57 s, and a client that reconnects by itself after a server restart.
- In rc.115, stopping a stream early after ≥200 items leaves the connection unable to answer any further call. A new connection works. Rule 2 avoids it; a regression test in M1 guards it.
- The RC moves fast (~200 merged PRs in three weeks, many stream and interrupt fixes). Upgrades are frequent, reviewed, and limited by the 14-day rule.
- All of RPC, HTTP, SQL and sockets are under `effect/unstable/*`, so API changes before 4.0 are expected.
- If the owner prefers Effect 3, the same design applies with `@effect/rpc` 0.x, and the migration cost moves to later.
