import type { HarnessId, RouteCost, ThreadId } from "@verdandi/contracts";
import { buildTaskOutcomes } from "@verdandi/trajectories";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { decodeRows, type StoredEventRow } from "./trajectory.ts";

/**
 * Rebuilds the outcomes of a thread's tasks from its events and saves them (DESIGN §8.8). Like
 * trajectories, an output never read back into state. Each outcome keeps the last event it was built
 * from, and only a newer one replaces it, so running this twice, or two at once, is harmless.
 */
export const recordTaskOutcomes = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // ponytail: reads the thread's events since its first task on every turn end, O(thread length).
    // Upgrade to starting at the oldest task whose outcome can still change once threads grow long.
    const events = yield* decodeRows(
      yield* sql<StoredEventRow>`
        select seq, event_id, command_id, at, type, v, payload from events
        where thread_id = ${threadId} and seq >= (select min(seq) from tasks where thread_id = ${threadId})
        order by seq`,
    );
    const seq = events.at(-1)?.seq;
    if (seq === undefined) return;
    const recordedAt = new Date().toISOString();
    yield* Effect.forEach(
      buildTaskOutcomes(events),
      (o) =>
        sql`insert into task_outcomes (task_id, status, cost_usd, payload, seq, recorded_at)
          values (${o.taskId}, ${o.status}, ${o.usage.reduce((sum, u) => sum + u.costUsd, 0)}, ${JSON.stringify(o)}, ${seq}, ${recordedAt})
          on conflict (task_id) do update set status = excluded.status, cost_usd = excluded.cost_usd, payload = excluded.payload,
            seq = excluded.seq, recorded_at = excluded.recorded_at
          where excluded.seq > task_outcomes.seq`,
      { discard: true },
    );
  });

/** Threads with a task whose outcome is missing, or older than a turn end, route change, rating or escalation: verdandid stopped before writing it. */
export const staleOutcomeThreads = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ thread_id: ThreadId }>`
    select distinct k.thread_id from tasks k left join task_outcomes o on o.task_id = k.id
    where o.task_id is null or exists (
      select 1 from events e
      where e.thread_id = k.thread_id and e.seq > o.seq and e.type in ('turn.completed', 'thread.route.changed', 'task.rated', 'task.escalated'))`,
);

/** Cost per completed task on each route with a recorded outcome, most spent first. */
export const loadTaskCosts = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  sql<{ harness: HarnessId; model: string; effort: RouteCost["route"]["effort"]; tasks: number; completed: number; cost_usd: number }>`
    select json_extract(k.route, '$.harness') as harness, json_extract(k.route, '$.model') as model,
      json_extract(k.route, '$.effort') as effort, count(*) as tasks, sum(o.status = 'completed') as completed, sum(o.cost_usd) as cost_usd
    from task_outcomes o join tasks k on k.id = o.task_id
    group by 1, 2, 3
    order by cost_usd desc, harness, model, effort`.pipe(
    Effect.map((rows) =>
      rows.map(
        (r): RouteCost => ({
          route: { harness: r.harness, model: r.model, effort: r.effort },
          tasks: r.tasks,
          completed: r.completed,
          costUsd: r.cost_usd,
          costPerCompletedUsd: r.completed > 0 ? r.cost_usd / r.completed : null,
        }),
      ),
    ),
  ),
);
