import type { HarnessId, RouteCost, ThreadId } from "@verdandi/contracts";
import { buildTaskOutcomes, outcomeEventTypes } from "@verdandi/trajectories";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { decodeRows, type StoredEventRow } from "./trajectory.ts";

/**
 * Rebuilds the outcomes of a thread's tasks from its events and saves them (DESIGN §8.8). Like trajectories, an
 * output never read back into state. It starts at the oldest task whose outcome can still change: the latest; one
 * built before the next task started (a follow-up's correction, recorded before that task, counts against it); one
 * without an outcome; or the first, when the user rated a task or reverted turns since the thread's last rebuild.
 * Each outcome keeps the last event it was built from, and only a newer one replaces it, so running this twice, or
 * two at once, is harmless.
 * ponytail: still reads all of the current task's events: 18 ms median, 25 ms p95 for a 1,000-turn task on an M4 Pro
 * (`apps/server/scripts/bench-rebuilds.ts`, #140). Upgrade to folding only the events since its last outcome, from a saved
 * builder state, if tasks that long show up.
 */
export const recordTaskOutcomes = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const events = yield* decodeRows(
      yield* sql<StoredEventRow>`
        with built as (
          select max(o.seq) as seq from task_outcomes o join tasks k on k.id = o.task_id where k.thread_id = ${threadId}),
        start as (
          select min(k.seq) as seq from tasks k left join task_outcomes o on o.task_id = k.id
          where k.thread_id = ${threadId} and (
            o.seq is null
            or o.seq < coalesce((select min(n.seq) from tasks n where n.thread_id = ${threadId} and n.seq > k.seq), o.seq + 1)
            or exists (select 1 from events e where e.thread_id = ${threadId} and e.seq > (select seq from built)
              and e.type in ('task.rated', 'thread.reverted', 'thread.revert.undone'))))
        select seq, event_id, command_id, at, type, v, payload from events
        where thread_id = ${threadId} and type in ${sql.in([...outcomeEventTypes])} and seq >= (select seq from start)
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
