import { decodeStoredEvent, type EventRow, type StoredEvent, type ThreadId, type TurnId } from "@verdandi/contracts";
import { buildTrajectory, redact } from "@verdandi/trajectories";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** An `events` row selected as `seq, event_id, command_id, at, type, v, payload`. */
export type StoredEventRow = EventRow & { seq: number; event_id: string; command_id: string; at: string };

export const decodeRows = (rows: readonly StoredEventRow[]) =>
  Effect.forEach(rows, (r) =>
    decodeStoredEvent(r).pipe(
      Effect.map((event): StoredEvent => ({ seq: r.seq, eventId: r.event_id, commandId: r.command_id, at: r.at, event })),
    ),
  );

/**
 * Builds a completed turn's trajectory from its events, redacts it and saves it. A turn that already
 * has one keeps it, so recording twice is harmless.
 */
export const recordTrajectory = (threadId: ThreadId, turnId: TurnId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* decodeRows(
      yield* sql<StoredEventRow>`
        select seq, event_id, command_id, at, type, v, payload from events
        where thread_id = ${threadId}
          and (type in ('thread.created', 'task.started', 'thread.route.changed', 'task.deescalated', 'harness.session.bound')
            or json_extract(payload, '$.turnId') = ${turnId})
        order by seq`,
    );
    const trajectory = buildTrajectory(events, turnId);
    if (!trajectory) return;
    yield* sql`insert into trajectories (turn_id, thread_id, provider, payload, recorded_at)
      values (${turnId}, ${threadId}, ${trajectory.provenance.provider}, ${JSON.stringify(redact(trajectory))}, ${new Date().toISOString()})
      on conflict (turn_id) do nothing`;
  });

/** Completed turns with no trajectory: verdandid stopped before writing it, or the turn predates trajectories. */
export const unrecordedTurns = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ id: TurnId; thread_id: ThreadId }>`
    select t.id, t.thread_id from turns t left join trajectories j on j.turn_id = t.id
    where t.status != 'running' and j.turn_id is null`,
);
