import type { Route, RouteStats, TaskClass, TaskOutcome, TaskStatus, ThreadId } from "@verdandi/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

type Tally = { -readonly [K in keyof RouteStats]: K extends "overrides" ? { to: Route; count: number }[] : RouteStats[K] };

const key = (r: Route) => `${r.harness} ${r.model} ${r.effort}`;
const counted: Partial<Record<TaskStatus, "completed" | "failed" | "escalated" | "reverted">> = {
  completed: "completed",
  failed: "failed",
  escalated: "escalated",
  reverted: "reverted",
};

/**
 * The routing memory of `threadId`'s project (DESIGN §8.8, level 1): how its routed and pinned tasks went,
 * per task class and route, from their outcomes since the memory was last cleared.
 * ponytail: rebuilt from every outcome in the project on each new task: 8 ms median, 14 ms p95 at 5,000 tasks on an
 * M4 Pro (`apps/agent/scripts/bench-rebuilds.ts`, #140). Upgrade to a running per-class, per-route tally once it passes ~20 ms.
 */
export const loadRoutingMemory = (threadId: ThreadId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ task_class: TaskClass; payload: string }>`
      select d.task_class, o.payload
      from task_outcomes o
        join tasks k on k.id = o.task_id
        join route_decisions d on d.task_id = k.id
        join threads t on t.id = k.thread_id
      where t.project_id = (select project_id from threads where id = ${threadId})
        and k.seq > coalesce((select m.cleared_seq from routing_memory m where m.project_id = t.project_id), 0)`.pipe(
      Effect.map((rows) => {
        const stats = new Map<string, Tally>();
        for (const row of rows) {
          const o = JSON.parse(row.payload) as TaskOutcome;
          const id = `${row.task_class} ${key(o.route)}`;
          const s: Tally = stats.get(id) ?? {
            taskClass: row.task_class,
            route: o.route,
            tasks: 0,
            completed: 0,
            failed: 0,
            escalated: 0,
            reverted: 0,
            overrides: [],
          };
          s.tasks++;
          // An escalated task counts against the route it started on, however it ended; one the user rated down didn't succeed.
          const status = o.escalations > 0 ? "escalated" : o.rating === -1 && o.status !== "reverted" ? "failed" : counted[o.status];
          if (status) s[status]++;
          const to = o.userOverride?.to;
          if (to) {
            const seen = s.overrides.find((x) => key(x.to) === key(to));
            if (seen) seen.count++;
            else s.overrides.push({ to, count: 1 });
          }
          stats.set(id, s);
        }
        return [...stats.values()].map((s): RouteStats => ({ ...s, overrides: s.overrides.toSorted((a, b) => b.count - a.count) }));
      }),
    ),
  );
