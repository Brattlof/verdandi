import type { Event, Item, Route, StoredEvent, ThreadId, ThreadView, TurnView } from "@verdandi/contracts";
import { Effect } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import type { DeciderState } from "./decider.ts";

type Projection<T extends Event["type"]> = (
  event: Extract<Event, { type: T }>,
  at: string,
) => Effect.Effect<unknown, SqlError.SqlError, SqlClient.SqlClient>;

const withSql = <A>(f: (sql: SqlClient.SqlClient) => Effect.Effect<A, SqlError.SqlError>) => Effect.flatMap(SqlClient.SqlClient, f);

const projections: { [T in Event["type"]]: Projection<T> } = {
  "thread.created": (e, at) =>
    withSql((sql) =>
      Effect.andThen(
        sql`insert into projects (id, path) values (${e.projectId}, ${e.projectPath}) on conflict (id) do nothing`,
        sql`insert into threads (id, project_id, route, created_at) values (${e.threadId}, ${e.projectId}, ${JSON.stringify(e.route)}, ${at})`,
      ),
    ),
  "turn.started": (e, at) =>
    withSql((sql) =>
      Effect.andThen(
        sql`insert into turns (id, thread_id, text, status, started_at) values (${e.turnId}, ${e.threadId}, ${e.text}, 'running', ${at})`,
        sql`update threads set running_turn_id = ${e.turnId} where id = ${e.threadId}`,
      ),
    ),
  "harness.session.bound": (e) => withSql((sql) => sql`update threads set session_id = ${e.sessionId} where id = ${e.threadId}`),
  "turn.item.added": (e) =>
    withSql(
      (sql) =>
        sql`insert into items (turn_id, idx, payload)
            values (${e.turnId}, (select count(*) from items where turn_id = ${e.turnId}), ${JSON.stringify(e.item)})`,
    ),
  "turn.usage.recorded": (e, at) =>
    withSql(
      (sql) =>
        sql`insert into usage_ledger (turn_id, model, access_mode, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, at)
            values (${e.turnId}, ${e.model}, ${e.accessMode}, ${e.inputTokens}, ${e.outputTokens}, ${e.cacheReadTokens}, ${e.cacheWriteTokens}, ${e.costUsd}, ${at})`,
    ),
  "turn.completed": (e, at) =>
    withSql((sql) =>
      Effect.andThen(
        sql`update turns set status = ${e.status}, error = ${e.error ?? null}, completed_at = ${at} where id = ${e.turnId}`,
        sql`update threads set running_turn_id = null where id = ${e.threadId} and running_turn_id = ${e.turnId}`,
      ),
    ),
};

/** Applies one event to the read models. Runs inside the engine's transaction. */
export const project = (stored: StoredEvent) =>
  (projections[stored.event.type] as Projection<Event["type"]>)(stored.event, stored.at).pipe(Effect.asVoid);

export const loadDeciderState = (threadId: ThreadId): Effect.Effect<DeciderState, SqlError.SqlError, SqlClient.SqlClient> =>
  withSql((sql) =>
    sql<{ path: string; running_turn_id: string | null; session_id: string | null }>`
      select p.path, t.running_turn_id, t.session_id from threads t join projects p on p.id = t.project_id where t.id = ${threadId}`.pipe(
      Effect.map(([row]) => ({
        thread: row && { projectPath: row.path, runningTurnId: row.running_turn_id, sessionId: row.session_id },
      })),
    ),
  );

export const loadThreadView = (threadId: ThreadId): Effect.Effect<ThreadView | null, SqlError.SqlError, SqlClient.SqlClient> =>
  withSql((sql) =>
    Effect.gen(function* () {
      const [thread] = yield* sql<{ path: string; route: string; session_id: string | null; running_turn_id: string | null }>`
        select p.path, t.route, t.session_id, t.running_turn_id from threads t join projects p on p.id = t.project_id where t.id = ${threadId}`;
      if (!thread) return null;
      const turns = yield* sql<{ id: string; text: string; status: TurnView["status"]; error: string | null }>`
        select id, text, status, error from turns where thread_id = ${threadId} order by started_at, rowid`;
      const items = yield* sql<{ turn_id: string; payload: string }>`
        select i.turn_id, i.payload from items i join turns t on t.id = i.turn_id where t.thread_id = ${threadId} order by i.turn_id, i.idx`;
      const itemsByTurn = Map.groupBy(items, (i) => i.turn_id);
      return {
        threadId,
        projectPath: thread.path,
        route: JSON.parse(thread.route) as Route,
        sessionId: thread.session_id,
        busy: thread.running_turn_id !== null,
        turns: turns.map(
          (t): TurnView => ({
            turnId: t.id as TurnView["turnId"],
            text: t.text,
            status: t.status,
            items: (itemsByTurn.get(t.id) ?? []).map((i) => JSON.parse(i.payload) as Item),
            ...(t.error === null ? {} : { error: t.error }),
          }),
        ),
      };
    }),
  );
