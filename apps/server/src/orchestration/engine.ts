import { randomUUID } from "node:crypto";
import {
  type Command,
  type CommandId,
  CommandRejected,
  type Event,
  encodeEvent,
  type ProjectsFeed,
  type Receipt,
  type StoredEvent,
  type ThreadFeed,
  type ThreadId,
  type TurnId,
} from "@verdandi/contracts";
import { correctingQuestion, type Decide } from "@verdandi/decisions";
import { Context, Effect, Layer, PubSub, Result, Stream } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import type { SpendCaps } from "../config/spend-caps.ts";
import { loadRoutingMemory } from "../routing/memory.ts";
import { type RoutingContext, rulesDecide, taskQuestions } from "../routing/routing.ts";
import { decide } from "./decider.ts";
import { loadDeciderState, loadProjects, loadQuotas, loadThreadSummaries, loadThreadView, project } from "./projector.ts";
import { loadSpendState } from "./spend.ts";

type FeedMessage = { readonly threadId: ThreadId; readonly feed: ThreadFeed };
type ThreadChange = Extract<ProjectsFeed, { kind: "thread" }>;
type ProjectsChange = Exclude<ProjectsFeed, { kind: "snapshot" }>;

/** Events that change a thread's summary in the projects feed. */
const summaryEvents: ReadonlySet<Event["type"]> = new Set([
  "thread.created",
  "thread.route.changed",
  "thread.archived",
  "thread.unarchived",
  "task.started",
  "turn.started",
  "turn.completed",
]);

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
    /**
     * A snapshot of every project and thread summary, then each summary again whenever it changes. The
     * snapshot leaves archived threads out unless `archived`; changes always come, so a client sees a thread leave.
     */
    readonly projectsFeed: (archived: boolean) => Stream.Stream<ProjectsFeed, SqlError.SqlError>;
    /** Deltas are broadcast to subscribers and never stored. */
    readonly publishDelta: (threadId: ThreadId, turnId: TurnId, text: string) => Effect.Effect<void>;
    readonly react: (reaction: Reaction) => Effect.Effect<void>;
  }
>()("verdandi/Engine") {}

export type EngineOptions = {
  readonly project?: Projector;
  /** Loads what routing a new task needs for a project. Without it tasks keep the thread's route, unexplained. */
  readonly routing?: (projectPath: string) => Effect.Effect<RoutingContext>;
  /** The decision layer that classifies new tasks and judges follow-ups. Defaults to `rules`. */
  readonly decide?: Decide["Service"];
  /** Reads the profile's spend caps. Without it no turn is capped. */
  readonly spendCaps?: Effect.Effect<Result.Result<SpendCaps, string>>;
};

export const EngineLive = (options: EngineOptions = {}) =>
  Layer.effect(
    Engine,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const pubsub = yield* PubSub.unbounded<FeedMessage>();
      const changes = yield* PubSub.unbounded<ProjectsChange>();
      const reactions: Reaction[] = [];
      const projectOne = options.project ?? project;
      const decider = options.decide ?? rulesDecide;

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
            if (existing)
              return {
                receipt: { commandId: command.commandId, seq: existing.seq },
                stored: [] as StoredEvent[],
                published: [] as ProjectsChange[],
              };
            const loaded = yield* loadDeciderState(command.threadId);
            // Caps are read on each turn and raise, so an edit to the caps file applies to the next one.
            const capped = (command.type === "turn.send" || command.type === "spend.cap.raise") && loaded.thread && options.spendCaps;
            const state = capped
              ? { ...loaded, spend: yield* loadSpendState(capped, loaded.thread?.projectPath ?? "", new Date()) }
              : loaded;
            const current = state.thread;
            const send = command.type === "turn.send" && current?.runningTurnId === null ? command : undefined;
            // A routed task started in plan mode routes its build when it proposes its plan.
            const plans =
              command.type === "harness.report" &&
              command.event.type === "plan.requested" &&
              current?.pinned === false &&
              current.taskPlanned;
            // Routing reads the project's policy file, so only when this command starts a task or routes a planned task's build.
            const routing =
              current && ((send && current.taskId === null) || plans) && options.routing
                ? {
                    ...(yield* options.routing(current.projectPath)),
                    // Routing memory moves where a task starts, not an approved plan's build.
                    ...(send ? { memory: yield* loadRoutingMemory(command.threadId) } : {}),
                  }
                : undefined;
            // A new task is classified, and a later turn is asked whether it corrects the agent's last answer.
            const questions = send ? [...(routing ? taskQuestions(routing) : []), ...(current?.turns ? [correctingQuestion] : [])] : [];
            // ponytail: asked inside the write transaction, which is free on `rules`; ask before it once a backend takes real time (ADR 0009).
            const decisions =
              send && questions.length > 0
                ? { questions, answers: (yield* decider.decide({ state: send.text, questions })).answers }
                : undefined;
            const decision = decide({ ...state, ...(routing && { routing }), ...(decisions && { decisions }) }, command);
            if (Result.isFailure(decision)) return yield* Effect.fail(decision.failure);
            const stored = yield* Effect.forEach(decision.success, (event) => append(command, event));
            const [last] = yield* sql<{ seq: number }>`select coalesce(max(seq), 0) as seq from events`;
            const seq = stored.at(-1)?.seq ?? last?.seq ?? 0;
            yield* sql`insert into command_receipts (command_id, seq) values (${command.commandId}, ${seq})`;
            // Read in the same transaction, so the summary is exactly the state as of `seq`.
            const [thread] = stored.some((s) => summaryEvents.has(s.event.type)) ? yield* loadThreadSummaries(command.threadId) : [];
            const created = stored.find((s) => s.event.type === "thread.created")?.event;
            const change: ThreadChange | undefined = thread && {
              kind: "thread",
              thread,
              seq,
              ...(created?.type === "thread.created" ? { project: { projectId: created.projectId, path: created.projectPath } } : {}),
            };
            const quotas = stored.flatMap((s): ProjectsChange[] =>
              s.event.type === "harness.quota.reported"
                ? [{ kind: "quota", quota: { harness: s.event.harness, quota: s.event.quota, at: s.at }, seq: s.seq }]
                : [],
            );
            return {
              receipt: { commandId: command.commandId as CommandId, seq },
              stored,
              published: change ? [change, ...quotas] : quotas,
            };
          }),
        );

      // Uninterruptible: once a command commits, its reactions must run. A client disconnecting mid-dispatch
      // would otherwise leave a committed turn.started with no harness run, and the thread busy.
      const dispatch = (command: Command) =>
        commit(command).pipe(
          Effect.tap(({ published }) => PubSub.publishAll(changes, published)),
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
          Effect.uninterruptible,
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

      const projectsFeed = (archived: boolean) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Same order as `feed`: subscribe, then read the snapshot.
            const subscription = yield* PubSub.subscribe(changes);
            const snapshot = yield* sql.withTransaction(
              Effect.all({
                projects: loadProjects,
                threads: loadThreadSummaries(undefined, archived),
                quotas: loadQuotas,
                seq: sql<{ seq: number }>`select coalesce(max(seq), 0) as seq from events`.pipe(Effect.map(([r]) => r?.seq ?? 0)),
              }),
            );
            // Commits can publish out of order, so drop a thread summary or quota older than the one the client already has.
            const latest = new Map<string, number>();
            const live = Stream.fromSubscription(subscription).pipe(
              Stream.filter((c) => {
                const key = c.kind === "thread" ? c.thread.threadId : `quota:${c.quota.harness}`;
                const newer = c.seq > (latest.get(key) ?? snapshot.seq);
                if (newer) latest.set(key, c.seq);
                return newer;
              }),
            );
            return Stream.concat(Stream.succeed<ProjectsFeed>({ kind: "snapshot", ...snapshot }), live);
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        );

      return Engine.of({
        dispatch: (command) => dispatch(command).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        feed,
        projectsFeed,
        publishDelta: (threadId, turnId, text) =>
          PubSub.publish(pubsub, { threadId, feed: { kind: "delta", turnId, text } }).pipe(Effect.asVoid),
        react: (reaction) => Effect.sync(() => void reactions.push(reaction)),
      });
    }),
  );
