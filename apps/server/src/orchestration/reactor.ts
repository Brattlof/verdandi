import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AttachmentRef,
  CommandId,
  HarnessAdapter,
  HarnessEvent,
  HarnessId,
  InteractionMode,
  Item,
  Route,
  TaskId,
  TaskLimits,
  ThreadId,
  TurnId,
} from "@verdandi/contracts";
import { Cause, Context, Effect, Fiber, FiberSet, Layer, Queue, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { checkpoint, checkpointRef } from "../workspace/checkpoint.ts";
import { editedPaths } from "../workspace/diff.ts";
import { runVerifier } from "../workspace/verify.ts";
import { Engine } from "./engine.ts";
import { recordTaskOutcomes, staleOutcomeThreads } from "./task-outcome.ts";
import { recordTrajectory, unrecordedTurns } from "./trajectory.ts";

export class HarnessRegistry extends Context.Service<HarnessRegistry, Partial<Record<HarnessId, HarnessAdapter>>>()(
  "verdandi/HarnessRegistry",
) {}

/** Where the profile keeps attachments' bytes, which harness turns read by path. */
export class AttachmentsDir extends Context.Service<AttachmentsDir, string>()("verdandi/AttachmentsDir") {}

/** The project's verifiers (`escalation.verifiers` in its routing policy), read when a turn needs them. */
export class ProjectVerifiers extends Context.Service<ProjectVerifiers, (projectPath: string) => Effect.Effect<readonly string[]>>()(
  "verdandi/ProjectVerifiers",
) {}

export class Reactor extends Context.Service<
  Reactor,
  {
    /** Completes when no turn is running. Tests wait on this instead of sleeping. */
    readonly drain: Effect.Effect<void>;
  }
>()("verdandi/Reactor") {}

const errorMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  if (error._tag === "Some" && typeof error.value === "object" && error.value !== null && "message" in error.value) {
    return String(error.value.message);
  }
  return `Verdandi hit an internal error while running this turn. Details: ${Cause.pretty(cause)}`;
};

/**
 * Runs harness turns as side effects of `turn.started`, feeds them `turn.steered` messages, moves a
 * running turn to an approved plan's build route, passes `approval.resolved` answers back to the harness, stops turns the user interrupted, records each
 * completed turn's trajectory and its task's outcome, and recovers turns a previous run left behind.
 */
export const ReactorLive = Layer.effect(
  Reactor,
  Effect.gen(function* () {
    const engine = yield* Engine;
    const registry = yield* HarnessRegistry;
    const attachmentsDir = yield* AttachmentsDir;
    const projectVerifiers = yield* ProjectVerifiers;
    const sql = yield* SqlClient.SqlClient;
    const turns = yield* FiberSet.make();
    /** The adapter running each thread's current turn: where answers to its requests go. */
    const live = new Map<ThreadId, HarnessAdapter>();
    // ponytail: a steer accepted in the moment between the harness finishing and turn.completed
    // committing is recorded but never delivered, since its turn is over. Upgrade: have the harness report delivery.
    const steerQueues = new Map<TurnId, Queue.Queue<string>>();
    /** Each thread's latest turn fiber: an interrupt stops it, and the thread's next turn waits for it to wind down. */
    const latest = new Map<ThreadId, { readonly turnId: TurnId; readonly fiber: Fiber.Fiber<void> }>();

    const report = (threadId: ThreadId, turnId: TurnId, event: HarnessEvent) =>
      engine.dispatch({ type: "harness.report", commandId: randomUUID() as CommandId, threadId, turnId, event });

    // A failed write is retried by the sweep below when verdandid next starts.
    const record = (threadId: ThreadId, turnId: TurnId) =>
      recordTrajectory(threadId, turnId).pipe(
        Effect.catchCause((cause) => Effect.logWarning(`Could not record the trajectory of turn ${turnId}.`, cause)),
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    const recordOutcomes = (threadId: ThreadId) =>
      recordTaskOutcomes(threadId).pipe(
        Effect.catchCause((cause) => Effect.logWarning(`Could not record the task outcomes of thread ${threadId}.`, cause)),
        Effect.provideService(SqlClient.SqlClient, sql),
      );

    /** Runs the project's verifiers in order until one fails, recording each on the turn before it completes (DESIGN §8.7). */
    const verify = (threadId: ThreadId, turnId: TurnId, projectPath: string) =>
      Effect.gen(function* () {
        for (const command of yield* projectVerifiers(projectPath)) {
          const run = yield* runVerifier(command, projectPath);
          yield* engine.dispatch({ type: "verifier.report", commandId: randomUUID() as CommandId, threadId, turnId, run });
          if (!run.passed) return;
        }
      });

    /** Saves the thread's tree as turn `turnId`'s start or end checkpoint (DESIGN §13). A failure is logged, never the turn's. */
    const saveCheckpoint = (threadId: ThreadId, turnId: TurnId, at: "start" | "end") =>
      Effect.gen(function* () {
        const [thread] = yield* sql<{ cwd: string }>`
          select p.path as cwd from threads t join projects p on p.id = t.project_id where t.id = ${threadId}`;
        // A folder outside git has no checkpoints, and `checkpoint` skips it.
        if (thread && existsSync(thread.cwd)) yield* checkpoint(thread.cwd, checkpointRef(threadId, turnId, at));
      }).pipe(Effect.catchCause((cause) => Effect.logWarning(`Could not save the ${at} checkpoint of turn ${turnId}.`, cause)));

    const runTurn = (
      threadId: ThreadId,
      turnId: TurnId,
      text: string,
      mode: InteractionMode,
      attachments: readonly AttachmentRef[],
      steers: Stream.Stream<string>,
    ) => {
      let finished = false;
      const fail = (error: string) => report(threadId, turnId, { type: "turn.finished", status: "error", error });
      return Effect.gen(function* () {
        // The task's budget guards, and what its turns before this one cost.
        const [thread] = yield* sql<{
          route: string;
          session_id: string | null;
          path: string;
          task_id: TaskId | null;
          limits: string | null;
          spent_usd: number;
        }>`
          select t.route, t.session_id, p.path, t.task_id, json_extract(d.payload, '$.limits') as limits,
            (select total(u.cost_usd) from usage_ledger u join turns n on n.id = u.turn_id
              where n.thread_id = t.id and n.started_at >= k.started_at and n.id != ${turnId}) as spent_usd
          from threads t join projects p on p.id = t.project_id
            left join tasks k on k.id = t.task_id left join route_decisions d on d.task_id = t.task_id
          where t.id = ${threadId}`;
        if (!thread) return yield* fail(`Thread ${threadId} disappeared before its turn ran.`);
        const route = JSON.parse(thread.route) as Route;
        const adapter = registry[route.harness];
        if (!adapter) return yield* fail(`The ${route.harness} harness is not available in this verdandid. Pick another route.`);
        live.set(threadId, adapter);
        const limits =
          thread.limits && thread.task_id
            ? { ...(JSON.parse(thread.limits) as TaskLimits), taskId: thread.task_id, spentUsd: thread.spent_usd }
            : undefined;
        // The turn's file-tool calls: once its agent is done, a turn that changed files is verified before it completes.
        const calls: Item[] = [];
        yield* adapter
          .run({
            threadId,
            cwd: thread.path,
            route,
            resumeSessionId: thread.session_id ?? undefined,
            turnId,
            text,
            mode,
            ...(attachments.length > 0 && { attachments: attachments.map((a) => ({ ...a, path: join(attachmentsDir, a.id) })) }),
            steers,
            ...(limits && { limits }),
          })
          .pipe(
            Stream.runForEach((event) => {
              if (event.type === "text.delta") return engine.publishDelta(threadId, turnId, event.text);
              if (event.type === "item" && event.item.kind === "tool.call") calls.push(event.item);
              if (event.type !== "turn.finished") return report(threadId, turnId, event);
              finished = true;
              // ponytail: a steer sent while verifiers run is recorded but never reaches the agent, which has finished.
              // Upgrade: hand it to the next turn, once escalation starts one (DESIGN §8.7).
              const verified =
                event.status === "success" && editedPaths(thread.path, calls).length > 0
                  ? verify(threadId, turnId, thread.path)
                  : Effect.void;
              return Effect.andThen(verified, report(threadId, turnId, event));
            }),
          );
        if (!finished) yield* fail("The harness stopped without finishing the turn.");
      }).pipe(
        Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) || finished ? Effect.failCause(cause) : fail(errorMessage(cause)))),
        Effect.ensuring(Effect.sync(() => live.delete(threadId))),
        Effect.ignore,
      );
    };

    const running = yield* sql<{ id: string; thread_id: string }>`select id, thread_id from turns where status = 'running'`;
    yield* Effect.forEach(
      running,
      (t) =>
        engine.dispatch({
          type: "turn.recover",
          commandId: randomUUID() as CommandId,
          threadId: t.thread_id as ThreadId,
          turnId: t.id as TurnId,
        }),
      { discard: true },
    );

    const startTurn = (threadId: ThreadId, turnId: TurnId, text: string, mode: InteractionMode, attachments: readonly AttachmentRef[]) =>
      Effect.gen(function* () {
        // Registered before the turn forks, so a steer accepted right after turn.started is never lost.
        const queue = yield* Queue.unbounded<string>();
        steerQueues.set(turnId, queue);
        const done = Effect.andThen(
          Effect.sync(() => steerQueues.delete(turnId)),
          Queue.shutdown(queue),
        );
        const previous = latest.get(threadId)?.fiber;
        const fiber = yield* FiberSet.run(
          turns,
          Effect.andThen(
            previous ? Fiber.await(previous) : Effect.void,
            // The end checkpoint waits for the harness to stop, even an interrupted one, and the next turn waits for it.
            Effect.andThen(
              saveCheckpoint(threadId, turnId, "start"),
              runTurn(threadId, turnId, text, mode, attachments, Stream.fromQueue(queue)),
            ).pipe(Effect.ensuring(saveCheckpoint(threadId, turnId, "end"))),
          ).pipe(
            Effect.ensuring(done),
            Effect.ensuring(Effect.sync(() => latest.get(threadId)?.turnId === turnId && latest.delete(threadId))),
          ),
        );
        latest.set(threadId, { turnId, fiber });
      });

    yield* engine.react((stored) => {
      const e = stored.event;
      if (e.type === "turn.started") return startTurn(e.threadId, e.turnId, e.text, e.mode ?? "build", e.attachments ?? []);
      if (e.type === "turn.steered") {
        const queue = steerQueues.get(e.turnId);
        return queue ? Queue.offer(queue, e.text).pipe(Effect.asVoid) : Effect.void;
      }
      // Committed right before the approval it goes with, so the harness switches before the agent's next step.
      if (e.type === "task.rerouted") return live.get(e.threadId)?.reroute(e.threadId, e.to) ?? Effect.void;
      if (e.type === "approval.resolved") return live.get(e.threadId)?.respond(e.threadId, e.requestId, e.resolution) ?? Effect.void;
      if (e.type === "turn.completed") {
        const turn = latest.get(e.threadId);
        // Forked into `turns`, so the dispatch doesn't wait for the harness to stop or the trajectory to be written, and `drain` does.
        const stop =
          e.status === "interrupted" && turn?.turnId === e.turnId ? FiberSet.run(turns, Fiber.interrupt(turn.fiber)) : Effect.void;
        return Effect.andThen(stop, FiberSet.run(turns, Effect.andThen(record(e.threadId, e.turnId), recordOutcomes(e.threadId)))).pipe(
          Effect.asVoid,
        );
      }
      // A route change is an override of the running task, and ends it.
      if (e.type === "thread.route.changed") return FiberSet.run(turns, recordOutcomes(e.threadId)).pipe(Effect.asVoid);
      return Effect.void;
    });

    // Turns that completed while nothing was listening: before a crash, in the recovery above, or before trajectories existed.
    yield* FiberSet.run(
      turns,
      Effect.all([
        unrecordedTurns.pipe(Effect.flatMap((missing) => Effect.forEach(missing, (t) => record(t.thread_id, t.id), { discard: true }))),
        staleOutcomeThreads.pipe(Effect.flatMap((stale) => Effect.forEach(stale, (t) => recordOutcomes(t.thread_id), { discard: true }))),
      ]).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.ignore),
    );

    return Reactor.of({ drain: FiberSet.awaitEmpty(turns) });
  }),
);
