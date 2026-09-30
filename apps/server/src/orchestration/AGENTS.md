# Orchestration

The event-sourced core of verdandid (DESIGN.md §10). Read the root `AGENTS.md` first; this file adds the rules for this folder.

## The pieces

| File | Role | May do |
|---|---|---|
| `decider.ts` | `decide(state, command)` returns the events a command causes, or a `CommandRejected`. | Nothing but compute. No I/O, no clock, no random IDs, no Effect services. |
| `projector.ts` | One projection per event type, applied to the read models (`projects`, `threads`, `turns`, `items`, `requests`, `usage_ledger`). Also loads `DeciderState`, `ThreadView` and the projects feed's thread summaries. | SQL writes to read models, inside the engine's transaction only. |
| `engine.ts` | `dispatch`: one transaction that checks the receipt, decides, appends each event and projects it, and writes the receipt. After the commit it publishes to feeds, then runs reactions. | Own the transaction and the feed PubSub. |
| `reactor.ts` | Side effects, triggered by committed events. Today: run a harness turn on `turn.started`, feed it `turn.steered` messages, pass `approval.resolved` answers to the harness running that thread, interrupt the fiber of a turn the user interrupted, and recover turns left `running` by a previous process. | Anything with side effects, but it only changes state by dispatching commands. |
| `app.ts` | Wires database, engine, harness registry and reactor into one layer. | |

## Rules

- **Events are the source of truth.** Read-model tables are derived from them. Never write a read-model table outside a projection, and never change state from a reactor except by dispatching a command (e.g. `harness.report`, `turn.recover`).
- **Adding an event** takes: a `v: 1` schema in `packages/contracts/src/events.ts`, its `type@v` entry in the decoder map, a case in the decider, and a projection (the handler maps are exhaustive, so the typechecker lists what's missing). Changing a published event means a new version plus an upgrade on read, never an edit. Migrations in `../persistence/migrations.ts` are append-only.
- **Commands are idempotent by `commandId`.** A retry returns the first receipt and emits nothing. Generate a fresh `commandId` for each intent, never reuse one across intents.
- **Accepting with no events is fine.** Duplicate session bindings, text deltas and stale recoveries all decide to `[]`.
- **Text deltas are never stored.** The reactor publishes them with `engine.publishDelta`; they reach live feeds only. Anything a client needs after a reconnect must be an event.
- **A thread's turns never overlap in its harness.** A new turn's fiber waits for the thread's previous one to finish, finalizers included, so an interrupted harness has wound down before the next turn reaches it.
- **Reactions must not block.** A `Reaction` runs inside `dispatch`, after the commit. Fork long work (the reactor uses a `FiberSet`) and return.
- **Dispatch is uninterruptible.** Once a command commits, its reactions run even if the caller disconnects. Keep what runs inside it short.
- **Harness failures become events.** Any way a turn can end (error, the harness stopping early, a missing adapter) must end in `turn.completed`, or the thread stays busy forever. Interrupts are the exception: `turn.interrupt` ends the turn before its harness stops, and on restart `turn.recover` marks turns a stopped verdandid left running. The decider drops reports from a turn that has already ended, except its session binding. Either way the decider denies the turn's pending requests first, so nothing waits on a turn that is over.
- **Tests wait on receipts and `Reactor.drain`,** never on sleeps. Use the fake harness from `@verdandi/testkit`.

## Feeds (ADR 0008)

Effect `4.0.0-rc.115` leaves a WebSocket connection unable to answer further calls if a client stops a server stream early. Until an Effect upgrade passes the early-stop check from spike 008, and in general:

- **Clients never stop a feed stream early.** A feed ends only when the client calls `Unsubscribe`, and the server interrupts the stream (`Stream.interruptWhen` in `../rpc/server.ts`; `haltWhen` would wait for the next event on an idle feed). Finite streams are read to the end.
- **Make other RPC calls outside the feed consumer.** Awaiting a call inside the `runForEach` that consumes a feed hung a test on macOS CI. Signal out of the consumer instead, the way `../cli/chat.ts` does.
- **Subscribe before reading the snapshot.** `engine.feed` and `engine.projectsFeed` subscribe to the PubSub first, then read the snapshot and its `seq` in one transaction, and drop live messages at or below that `seq`. Thread summaries are read inside the commit that changed them and carry its `seq`, so the projects feed also drops one older than the summary it last sent. Keep that order, or events committed in between are lost or duplicated.

Each Effect upgrade re-runs the early-stop check. When it passes, drop the first rule here and rule 2 of ADR 0008. The second rule has its own cause, which hasn't been pinned down, so it stays until a test shows it's safe to drop.
