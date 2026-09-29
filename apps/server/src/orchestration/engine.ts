import { randomUUID } from "node:crypto";
import {
  type Command,
  type CommandId,
  CommandRejected,
  type Event,
  encodeEvent,
  type Receipt,
  type StoredEvent,
  type ThreadFeed,
  type ThreadId,
  type TurnId,
} from "@goldiloop/contracts";
import { Context, Effect, Layer, PubSub, Result, Stream } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import { decide } from "./decider.ts";
import { loadDeciderState, loadThreadView, project } from "./projector.ts";

type FeedMessage = { readonly threadId: ThreadId; readonly feed: ThreadFeed };

/** Runs after each commit with the new events. Must not block: fork long work. */
export type Reaction = (stored: StoredEvent) => Effect.Effect<void>;

export type Projector = (stored: StoredEvent) => Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>;

export class Engine extends Context.Service<
  Engine,
  {
    /** Saves the command's events and projections in one transaction; retries return the first receipt. */
    readonly dispatch: (command: Command) => Effect.Effect<Receipt, CommandRejected | SqlError.SqlError>;
    /** A snapshot of the thread, then its events and text deltas as they happen. */
    readonly feed: (threadId: ThreadId) => Stream.Stream<ThreadFeed, CommandRejected | SqlError.SqlError>;
    /** Deltas are broadcast to subscribers and never stored. */
    readonly publishDelta: (threadId: ThreadId, turnId: TurnId, text: string) => Effect.Effect<void>;
    readonly react: (reaction: Reaction) => Effect.Effect<void>;
  }
>()("goldiloop/Engine") {}

export const EngineLive = (options: { readonly project?: Projector } = {}) =>
  Layer.effect(
    Engine,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const pubsub = yield* PubSub.unbounded<FeedMessage>();
      const reactions: Reaction[] = [];
      const projectOne = options.project ?? project;

      const append = (command: Command, event: Event) =>
        Effect.gen(function* () {
          const row = encodeEvent(event);
          const eventId = randomUUID();
          const at = new Date().toISOString();
          const [inserted] = yield* sql<{ seq: number }>`
            insert into events (event_id, command_id, thread_id, type, v, at, payload)
            values (${eventId}, ${command.commandId}, ${command.threadId}, ${row.type}, ${row.v}, ${at}, ${row.payload})
            returning seq`;
          const stored: StoredEvent = { seq: inserted?.seq ?? 0, eventId, commandId: command.commandId, at, event };
          yield* projectOne(stored);
          return stored;
        });

      const commit = (command: Command) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const [existing] = yield* sql<{ seq: number }>`select seq from command_receipts where command_id = ${command.commandId}`;
            if (existing) return { receipt: { commandId: command.commandId, seq: existing.seq }, stored: [] as StoredEvent[] };
            const decision = decide(yield* loadDeciderState(command.threadId), command);
            if (Result.isFailure(decision)) return yield* Effect.fail(decision.failure);
            const stored = yield* Effect.forEach(decision.success, (event) => append(command, event));
            const [last] = yield* sql<{ seq: number }>`select coalesce(max(seq), 0) as seq from events`;
            const seq = stored.at(-1)?.seq ?? last?.seq ?? 0;
            yield* sql`insert into command_receipts (command_id, seq) values (${command.commandId}, ${seq})`;
            return { receipt: { commandId: command.commandId as CommandId, seq }, stored };
          }),
        );

      const dispatch = (command: Command) =>
        commit(command).pipe(
          Effect.tap(({ stored }) =>
            Effect.forEach(
              stored,
              (s) =>
                Effect.andThen(
                  PubSub.publish(pubsub, { threadId: s.event.threadId, feed: { kind: "event", stored: s } }),
                  Effect.forEach(reactions, (react) => react(s), { discard: true }),
                ),
              { discard: true },
            ),
          ),
          Effect.map(({ receipt }) => receipt),
        );

      const feed = (threadId: ThreadId) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe before reading the snapshot so nothing committed in between is lost.
            const subscription = yield* PubSub.subscribe(pubsub);
            const { thread, seq } = yield* sql.withTransaction(
              Effect.all({
                thread: loadThreadView(threadId),
                seq: sql<{ seq: number }>`select coalesce(max(seq), 0) as seq from events where thread_id = ${threadId}`.pipe(
                  Effect.map(([r]) => r?.seq ?? 0),
                ),
              }),
            );
            if (!thread) return yield* new CommandRejected({ reason: "ThreadNotFound", message: `Thread ${threadId} does not exist.` });
            const live = Stream.fromSubscription(subscription).pipe(
              Stream.filter((m) => m.threadId === threadId && (m.feed.kind !== "event" || m.feed.stored.seq > seq)),
              Stream.map((m) => m.feed),
            );
            return Stream.concat(Stream.succeed<ThreadFeed>({ kind: "snapshot", thread, seq }), live);
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        );

      return Engine.of({
        dispatch: (command) => dispatch(command).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        feed,
        publishDelta: (threadId, turnId, text) =>
          PubSub.publish(pubsub, { threadId, feed: { kind: "delta", turnId, text } }).pipe(Effect.asVoid),
        react: (reaction) => Effect.sync(() => void reactions.push(reaction)),
      });
    }),
  );
