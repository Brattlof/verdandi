import { randomUUID } from "node:crypto";
import type { CommandId, HarnessAdapter, HarnessEvent, HarnessId, InteractionMode, Route, ThreadId, TurnId } from "@verdandi/contracts";
import { Cause, Context, Effect, Fiber, FiberSet, Layer, Queue, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Engine } from "./engine.ts";
import { recordTrajectory, unrecordedTurns } from "./trajectory.ts";

export class HarnessRegistry extends Context.Service<HarnessRegistry, Partial<Record<HarnessId, HarnessAdapter>>>()(
  "verdandi/HarnessRegistry",
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
 * Runs harness turns as side effects of `turn.started`, feeds them `turn.steered` messages, passes
 * `approval.resolved` answers back to the harness, stops turns the user interrupted, records each
 * completed turn's trajectory, and recovers turns a previous run left behind.
 */
export const ReactorLive = Layer.effect(
  Reactor,
  Effect.gen(function* () {
    const engine = yield* Engine;
    const registry = yield* HarnessRegistry;
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

    const runTurn = (threadId: ThreadId, turnId: TurnId, text: string, mode: InteractionMode, steers: Stream.Stream<string>) => {
      let finished = false;
      const fail = (error: string) => report(threadId, turnId, { type: "turn.finished", status: "error", error });
      return Effect.gen(function* () {
        const [thread] = yield* sql<{ route: string; session_id: string | null; path: string }>`
          select t.route, t.session_id, p.path from threads t join projects p on p.id = t.project_id where t.id = ${threadId}`;
        if (!thread) return yield* fail(`Thread ${threadId} disappeared before its turn ran.`);
        const route = JSON.parse(thread.route) as Route;
        const adapter = registry[route.harness];
        if (!adapter) return yield* fail(`The ${route.harness} harness is not available in this verdandid. Pick another route.`);
        live.set(threadId, adapter);
        yield* adapter
          .run({ threadId, cwd: thread.path, route, resumeSessionId: thread.session_id ?? undefined, turnId, text, mode, steers })
          .pipe(
            Stream.runForEach((event) => {
              if (event.type === "text.delta") return engine.publishDelta(threadId, turnId, event.text);
              if (event.type === "turn.finished") finished = true;
              return report(threadId, turnId, event);
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

    const startTurn = (threadId: ThreadId, turnId: TurnId, text: string, mode: InteractionMode) =>
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
            runTurn(threadId, turnId, text, mode, Stream.fromQueue(queue)),
          ).pipe(
            Effect.ensuring(done),
            Effect.ensuring(Effect.sync(() => latest.get(threadId)?.turnId === turnId && latest.delete(threadId))),
          ),
        );
        latest.set(threadId, { turnId, fiber });
      });

    yield* engine.react((stored) => {
      const e = stored.event;
      if (e.type === "turn.started") return startTurn(e.threadId, e.turnId, e.text, e.mode ?? "build");
      if (e.type === "turn.steered") {
        const queue = steerQueues.get(e.turnId);
        return queue ? Queue.offer(queue, e.text).pipe(Effect.asVoid) : Effect.void;
      }
      if (e.type === "approval.resolved") return live.get(e.threadId)?.respond(e.threadId, e.requestId, e.resolution) ?? Effect.void;
      if (e.type === "turn.completed") {
        const turn = latest.get(e.threadId);
        // Forked into `turns`, so the dispatch doesn't wait for the harness to stop or the trajectory to be written, and `drain` does.
        const stop =
          e.status === "interrupted" && turn?.turnId === e.turnId ? FiberSet.run(turns, Fiber.interrupt(turn.fiber)) : Effect.void;
        return Effect.andThen(stop, FiberSet.run(turns, record(e.threadId, e.turnId))).pipe(Effect.asVoid);
      }
      return Effect.void;
    });

    // Turns that completed while nothing was listening: before a crash, in the recovery above, or before trajectories existed.
    yield* FiberSet.run(
      turns,
      unrecordedTurns.pipe(
        Effect.flatMap((missing) => Effect.forEach(missing, (t) => record(t.thread_id, t.id), { discard: true })),
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.ignore,
      ),
    );

    return Reactor.of({ drain: FiberSet.awaitEmpty(turns) });
  }),
);
