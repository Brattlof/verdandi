import { randomUUID } from "node:crypto";
import {
  atPin,
  type Catalog,
  type Command,
  type CommandId,
  CommandRejected,
  commandStream,
  type Event,
  encodeEvent,
  isCorrection,
  type ProjectsFeed,
  type Receipt,
  type SkillChange,
  type SkillState,
  type StoredEvent,
  type ThreadFeed,
  type ThreadId,
  type TurnId,
} from "@verdandi/contracts";
import { correctingQuestion, type Decide, injectionQuestion, reviewQuestion } from "@verdandi/decisions";
import { Context, Effect, Layer, PubSub, Result, Stream } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import { type RoutingContext, rulesDecide, taskQuestions } from "../routing/routing.ts";
import { loadRoutingMemory } from "../routing/routing-memory.ts";
import { loadShortQuota, loadSpendState } from "../spend/spend.ts";
import type { SpendCaps } from "../spend/spend-caps.ts";
import { decide, handedText } from "./decider.ts";
import { loadDeciderState, loadMemory, loadProjects, loadQuotas, loadThreadSummaries, loadThreadView, project } from "./projector.ts";

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
    readonly projectsFeed: (archived: boolean, workspace: string) => Stream.Stream<ProjectsFeed, SqlError.SqlError>;
    /** Deltas are broadcast to subscribers while their turn runs, and never stored. */
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
  /** The model catalog, which tells the turns a reached spend cap stops: those that spend metered dollars. Without it, every turn. */
  readonly catalog?: Catalog;
};

export const EngineLive = (options: EngineOptions = {}) =>
  Layer.effect(
    Engine,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const pubsub = yield* PubSub.unbounded<FeedMessage>();
      const changes = yield* PubSub.unbounded<ProjectsChange>();
      const reactions: Reaction[] = [];
      // Turns whose deltas reach feeds: from `turn.started` until `turn.completed` is published. An interrupted turn
      // completes before its harness winds down, and what the harness streams meanwhile is dropped.
      const streaming = new Set<TurnId>();
      const projectOne = options.project ?? project;
      const decider = options.decide ?? rulesDecide;

      const append = (command: Command, event: Event) =>
        Effect.gen(function* () {
          const row = encodeEvent(event);
          const eventId = randomUUID();
          const at = new Date().toISOString();
          const [inserted] = yield* sql<{ seq: number }>`
            insert into events (event_id, command_id, thread_id, type, v, at, payload)
            values (${eventId}, ${command.commandId}, ${commandStream(command)}, ${row.type}, ${row.v}, ${at}, ${row.payload})
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
            const stream = commandStream(command);
            const loaded = yield* loadDeciderState(stream);
            // Rejecting a routed task's plan escalates it (DESIGN §8.7), which reads the project's policy and caps.
            const rejectsPlan =
              command.type === "approval.respond" &&
              command.resolution.decision === "deny" &&
              loaded.thread?.pinned === false &&
              loaded.thread.pendingRequests.some((r) => r.requestId === command.requestId && r.kind === "plan");
            // Caps are read on each turn and raise, so an edit to the caps file applies to the next one.
            // A proposed plan's build is routed around a reached cap too.
            const capped =
              (command.type === "turn.send" ||
                command.type === "spend.cap.raise" ||
                command.type === "task.escalate" ||
                rejectsPlan ||
                (command.type === "harness.report" && command.event.type === "plan.requested")) &&
              loaded.thread &&
              options.spendCaps;
            const state = capped
              ? {
                  ...loaded,
                  spend: yield* loadSpendState(capped, loaded.thread?.projectPath ?? "", new Date()),
                  ...(options.catalog && { catalog: options.catalog }),
                }
              : loaded;
            const current = state.thread;
            const send = command.type === "turn.send" && current?.runningTurnId === null ? command : undefined;
            // A leading `@name` starts a task of its own, pinned to that model; the decision layer reads the text without it.
            const at = send && atPin(send.text);
            // A routed task started in plan mode routes its build when it proposes its plan.
            const plans =
              command.type === "harness.report" &&
              command.event.type === "plan.requested" &&
              current?.pinned === false &&
              current.taskPlanned;
            // An escalation's next step comes from the project's policy too.
            const escalates = command.type === "task.escalate" && current?.pinned === false;
            const starts = send && current && (current.taskId === null || at);
            // A routed task's turn after one whose verifiers all passed is classified too: mechanical work de-escalates it.
            const deescalates = send && !starts && current?.pinned === false && current.lastTurnVerified;
            // Routing reads the project's policy file, so only when this command starts a task, routes a planned task's build,
            // escalates or may de-escalate.
            const routing =
              current && (starts || plans || escalates || rejectsPlan || deescalates) && options.routing
                ? {
                    ...(yield* options.routing(current.projectPath)),
                    // Routing memory moves where a task starts, not an approved plan's build or a running task.
                    ...(starts ? { memory: yield* loadRoutingMemory(stream) } : {}),
                  }
                : undefined;
            // A new task is classified, and a later turn is asked whether it corrects the agent's last answer. A background
            // review's turn isn't: Verdandi wrote it, in its own class (DESIGN §14.5).
            const questions =
              send && !current?.aux ? [...(routing ? taskQuestions(routing) : []), ...(current?.turns ? [correctingQuestion] : [])] : [];
            // A finished task's digest is asked whether it's worth a background review.
            const asked =
              send && questions.length > 0
                ? { state: at ? at.text : send.text, questions }
                : command.type === "task.review"
                  ? { state: command.digest, questions: [reviewQuestion] }
                  : undefined;
            // ponytail: asked inside the write transaction, which is free on `rules`; ask before it once a backend takes real time (ADR 0009).
            const decisions = asked && { questions: asked.questions, answers: (yield* decider.decide(asked)).answers };
            // A follow-up correcting the agent may escalate its routed task (DESIGN §8.7), which reads the project's policy.
            const corrects =
              current && send && !routing && !at && current.taskId !== null && !current.pinned && decisions?.answers.some(isCorrection);
            const policy = routing ?? (current && corrects && options.routing ? yield* options.routing(current.projectPath) : undefined);
            // Memory: read for memory commands, a background review's proposals and the answer to one, and for a turn whose
            // new harness session starts with a snapshot of it.
            const remembers =
              command.type.startsWith("memory.") ||
              command.type === "review.propose" ||
              (command.type === "approval.respond" &&
                current?.pendingRequests.some((r) => r.requestId === command.requestId && r.kind === "memory")) ||
              (send !== undefined && current?.sessionId === null);
            const memory = remembers ? yield* loadMemory(stream) : null;
            // Untrusted text the command would keep or hand the agent is scanned for injection (DESIGN §17).
            const untrusted =
              command.type === "memory.save" || command.type === "memory.edit"
                ? command.text.trim()
                : command.type === "skill.propose"
                  ? (command.change.after ?? undefined)
                  : command.type === "review.propose"
                    ? command.proposal.kind === "memory"
                      ? command.proposal.text.trim()
                      : (command.proposal.change.after ?? undefined)
                    : escalates && command.type === "task.escalate"
                      ? handedText(command.trigger)
                      : undefined;
            const [injection] =
              untrusted === undefined ? [] : (yield* decider.decide({ state: untrusted, questions: [injectionQuestion] })).answers;
            // A skill Verdandi created has a row in `skills`; any other is never curated or restored.
            const skill =
              command.type === "skill.curate" || command.type === "skill.restore"
                ? ((yield* sql<{ state: SkillState; usedAt: string }>`
                    select state, used_at as usedAt from skills where name = ${command.skill}`)[0] ?? null)
                : undefined;
            // A pin stops agents' proposals and the sweep; the user's own pin, unpin and revert read it too.
            const pinnedName =
              command.type === "skill.propose"
                ? command.change.skill
                : command.type === "review.propose" && command.proposal.kind === "skill"
                  ? command.proposal.change.skill
                  : command.type === "skill.curate" || command.type === "skill.pin" || command.type === "skill.unpin"
                    ? command.skill
                    : undefined;
            const pinned =
              pinnedName === undefined ? undefined : (yield* sql`select 1 from skill_pins where name = ${pinnedName}`).length > 0;
            const reverting =
              command.type === "skill.revert"
                ? ((yield* sql<{ threadId: ThreadId; change: string; appliedAt: string | null; error: string | null }>`
                    select thread_id as threadId, change, applied_at as appliedAt, error from skill_changes where id = ${command.changeId}`).map(
                    (r) => ({ ...r, change: JSON.parse(r.change) as SkillChange }),
                  )[0] ?? null)
                : undefined;
            const device =
              command.type === "device.pair" || command.type === "device.revoke"
                ? ((yield* sql<{
                    revoked: number;
                  }>`select revoked_at is not null as revoked from devices where id = ${command.deviceId}`).map((r) => ({
                    revoked: r.revoked === 1,
                  }))[0] ?? null)
                : undefined;
            // A background review stays off a harness whose subscription window is short (DESIGN §14.5).
            const shortQuota = send && current?.aux ? yield* loadShortQuota(new Date()) : undefined;
            const decision = decide(
              {
                ...state,
                ...(policy && { routing: policy }),
                ...(decisions && { decisions }),
                ...(memory && { memory }),
                ...(injection && { injection }),
                ...(skill !== undefined && { skill }),
                ...(pinned !== undefined && { pinned }),
                ...(reverting !== undefined && { reverting }),
                ...(device !== undefined && { device }),
                ...(shortQuota && { shortQuota }),
              },
              command,
            );
            if (Result.isFailure(decision)) return yield* Effect.fail(decision.failure);
            const stored = yield* Effect.forEach(decision.success, (event) => append(command, event));
            const [last] = yield* sql<{ seq: number }>`select coalesce(max(seq), 0) as seq from events`;
            const seq = stored.at(-1)?.seq ?? last?.seq ?? 0;
            yield* sql`insert into command_receipts (command_id, seq) values (${command.commandId}, ${seq})`;
            // Read in the same transaction, so the summary is exactly the state as of `seq`.
            const [thread] = stored.some((s) => summaryEvents.has(s.event.type)) ? yield* loadThreadSummaries(stream) : [];
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
                Effect.sync(() => {
                  if (s.event.type === "turn.started") streaming.add(s.event.turnId);
                  if (s.event.type === "turn.completed") streaming.delete(s.event.turnId);
                }).pipe(
                  Effect.andThen(PubSub.publish(pubsub, { threadId: s.event.threadId, feed: { kind: "event", stored: s } })),
                  Effect.andThen(Effect.forEach(reactions, (react) => react(s), { discard: true })),
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

      const projectsFeed = (archived: boolean, workspace: string) =>
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
            return Stream.concat(Stream.succeed<ProjectsFeed>({ kind: "snapshot", ...snapshot, workspace }), live);
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        );

      return Engine.of({
        dispatch: (command) => dispatch(command).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
        feed,
        projectsFeed,
        // Checked and published in one step, so no delta can follow its turn's `turn.completed` on a feed.
        publishDelta: (threadId, turnId, text) =>
          Effect.sync(() => {
            if (streaming.has(turnId)) PubSub.publishUnsafe(pubsub, { threadId, feed: { kind: "delta", turnId, text } });
          }),
        react: (reaction) => Effect.sync(() => void reactions.push(reaction)),
      });
    }),
  );
