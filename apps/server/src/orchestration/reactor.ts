import { randomUUID } from "node:crypto";
import type { CommandId, HarnessAdapter, HarnessEvent, HarnessId, Route, ThreadId, TurnId } from "@verdandi/contracts";
import { Cause, Context, Effect, FiberSet, Layer, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Engine } from "./engine.ts";

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
 * Runs harness turns as side effects of `turn.started`, passes `approval.resolved` answers back to the
 * harness, and recovers turns a previous run left behind.
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

    const report = (threadId: ThreadId, turnId: TurnId, event: HarnessEvent) =>
      engine.dispatch({ type: "harness.report", commandId: randomUUID() as CommandId, threadId, turnId, event });

    const runTurn = (threadId: ThreadId, turnId: TurnId, text: string) => {
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
        yield* adapter.run({ threadId, cwd: thread.path, route, resumeSessionId: thread.session_id ?? undefined, turnId, text }).pipe(
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

    yield* engine.react((stored) => {
      const e = stored.event;
      if (e.type === "turn.started") return FiberSet.run(turns, runTurn(e.threadId, e.turnId, e.text)).pipe(Effect.asVoid);
      if (e.type === "approval.resolved") return live.get(e.threadId)?.respond(e.threadId, e.requestId, e.resolution) ?? Effect.void;
      return Effect.void;
    });

    return Reactor.of({ drain: FiberSet.awaitEmpty(turns) });
  }),
);
