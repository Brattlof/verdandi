import { randomUUID } from "node:crypto";
import type { CommandId, ThreadId } from "@verdandi/contracts";
import { Effect, Layer, Queue } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Engine } from "../event-store/engine.ts";
import { loadDueJob } from "./schedule-store.ts";

/**
 * The longest the timer sleeps before it looks again. A host that slept, or a clock that jumped, is noticed within it;
 * the catch-up rules then decide what the missed occurrences become (ADR 0032).
 */
const recheckMs = 60_000;

/**
 * verdandid's scheduler (DESIGN §15), only in an always-on verdandid (`verdandi start`; DESIGN §11). One timer waits
 * for the active job whose next run comes first, re-armed at boot and whenever a job changes; when it fires it
 * dispatches `schedule.fire`, and the decider claims the occurrence at most once. Overdue jobs fire at boot, where
 * catch-up applies.
 */
export const SchedulerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const engine = yield* Engine;
    const sql = yield* SqlClient.SqlClient;
    const changed = yield* Queue.sliding<void>(1);
    yield* engine.react((s) => (s.event.type.startsWith("schedule.") ? Queue.offer(changed, undefined).pipe(Effect.asVoid) : Effect.void));
    /** The occurrence fired last, so one the decider left due (which it shouldn't) can't spin the timer. */
    let fired = "";
    const tick = Effect.gen(function* () {
      const due = yield* loadDueJob.pipe(Effect.provideService(SqlClient.SqlClient, sql));
      const wait = due ? Math.min(recheckMs, Math.max(0, Date.parse(due.next_run_at) - Date.now())) : recheckMs;
      const woke = yield* Effect.raceFirst(
        Effect.as(Effect.sleep(wait), "timer" as const),
        Effect.as(Queue.take(changed), "changed" as const),
      );
      if (woke === "changed" || !due || Date.parse(due.next_run_at) > Date.now()) return;
      const occurrence = `${due.id}@${due.next_run_at}`;
      if (occurrence === fired) {
        yield* Effect.logWarning(`Job ${due.id} is still due at ${due.next_run_at} after firing; the scheduler waits a minute.`);
        return yield* Effect.sleep(recheckMs);
      }
      fired = occurrence;
      yield* engine.dispatch({
        type: "schedule.fire",
        commandId: randomUUID() as CommandId,
        threadId: due.owner_thread_id,
        jobId: due.id,
        scheduledInstant: due.next_run_at,
        runThreadId: randomUUID() as ThreadId,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("The scheduler couldn't fire a job; it tries again in a minute.", cause).pipe(
          Effect.andThen(Effect.sleep(recheckMs)),
        ),
      ),
    );
    yield* Effect.forkScoped(Effect.forever(tick));
  }),
);
