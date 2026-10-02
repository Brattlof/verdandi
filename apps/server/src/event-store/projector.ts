import type {
  AttachmentRef,
  BudgetMode,
  Event,
  Item,
  MemoryEntry,
  MemoryScope,
  MemoryView,
  ProjectId,
  ProjectSummary,
  Quota,
  QuotaView,
  Route,
  RouteChange,
  RouteDecision,
  SessionHit,
  StoredEvent,
  TaskId,
  TaskRating,
  ThreadId,
  ThreadSummary,
  ThreadView,
  TurnId,
  TurnView,
  Usage,
  WorktreeView,
} from "@verdandi/contracts";
import { clip, injectionItem, nextWorktree } from "@verdandi/contracts";
import { Effect } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import type { DeciderState, PendingRequest } from "./decider.ts";

type Projection<T extends Event["type"]> = (
  event: Extract<Event, { type: T }>,
  at: string,
  seq: number,
) => Effect.Effect<unknown, SqlError.SqlError, SqlClient.SqlClient>;

const withSql = <A>(f: (sql: SqlClient.SqlClient) => Effect.Effect<A, SqlError.SqlError>) => Effect.flatMap(SqlClient.SqlClient, f);

const requestKind = { "approval.requested": "approval", "user-input.requested": "user-input", "plan.requested": "plan" } as const;

const insertRequest = (e: Extract<Event, { type: keyof typeof requestKind }>, at: string) =>
  withSql(
    (sql) =>
      sql`insert into requests (id, thread_id, turn_id, kind, payload, requested_at)
          values (${e.requestId}, ${e.threadId}, ${e.turnId}, ${requestKind[e.type]}, ${JSON.stringify(e)}, ${at})`,
  );

/** Adds a message to session search (DESIGN §14.3). */
const indexMessage = (threadId: ThreadId, turnId: TurnId, kind: SessionHit["kind"], text: string, at: string) =>
  withSql(
    (sql) => sql`insert into session_index (text, thread_id, turn_id, kind, at) values (${text}, ${threadId}, ${turnId}, ${kind}, ${at})`,
  );

const addItem = (turnId: TurnId, item: Item) =>
  withSql(
    (sql) =>
      sql`insert into items (turn_id, idx, payload)
          values (${turnId}, (select count(*) from items where turn_id = ${turnId}), ${JSON.stringify(item)})`,
  );

/** The thread's latest revert as `threads.revert` keeps it: what undoing it needs, and what its view shows. */
export type StoredRevert = {
  readonly toTurnId: TurnId;
  readonly turnIds: readonly TurnId[];
  readonly files: boolean;
  readonly undone: boolean;
  /** The fork pending before this revert, which undoing it puts back. */
  readonly prevFork: string | null;
  /** The checkpoint of the files from before the revert. */
  readonly saved?: string | null;
  readonly filesError?: string | null;
};

const revertView = (stored: string | null): ThreadView["revert"] => {
  if (stored === null) return null;
  const r = JSON.parse(stored) as StoredRevert;
  return { toTurnId: r.toTurnId, files: r.files, undone: r.undone, ...(r.filesError ? { filesError: r.filesError } : {}) };
};

/** Folds a worktree event into the thread's `worktree` column. */
const projectWorktree = (e: Parameters<typeof nextWorktree>[1]) =>
  withSql((sql) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{ worktree: string | null }>`select worktree from threads where id = ${e.threadId}`;
      const next = nextWorktree(row?.worktree ? (JSON.parse(row.worktree) as WorktreeView) : null, e);
      yield* sql`update threads set worktree = ${next && JSON.stringify(next)} where id = ${e.threadId}`;
    }),
  );

const projections: { [T in Event["type"]]: Projection<T> } = {
  "thread.created": (e, at) =>
    withSql((sql) =>
      Effect.andThen(
        sql`insert into projects (id, path) values (${e.projectId}, ${e.projectPath}) on conflict (id) do nothing`,
        sql`insert into threads (id, project_id, route, pinned, created_at)
            values (${e.threadId}, ${e.projectId}, ${JSON.stringify(e.route)}, ${e.pinned === false ? 0 : 1}, ${at})`,
      ),
    ),
  // A session belongs to one harness, so switching harness starts a fresh one on the next turn. Either way the next turn starts a task.
  "thread.route.changed": (e, at, seq) =>
    withSql((sql) =>
      Effect.andThen(
        e.from.harness === e.to.harness
          ? sql`update threads set route = ${JSON.stringify(e.to)}, pinned = 1, task_id = null where id = ${e.threadId}`
          : sql`update threads set route = ${JSON.stringify(e.to)}, pinned = 1, session_id = null, task_id = null where id = ${e.threadId}`,
        sql`insert into route_changes (seq, thread_id, from_route, to_route, by, after_turns, at)
            values (${seq}, ${e.threadId}, ${JSON.stringify(e.from)}, ${JSON.stringify(e.to)}, ${e.by},
              (select count(*) from turns where thread_id = ${e.threadId}), ${at})`,
      ),
    ),
  "task.started": (e, at, seq) =>
    withSql((sql) =>
      Effect.gen(function* () {
        yield* sql`insert into tasks (id, thread_id, route, seq, started_at) values (${e.taskId}, ${e.threadId}, ${JSON.stringify(e.route)}, ${seq}, ${at})`;
        // The router may move the thread to another harness, whose session starts fresh. SET reads the old route.
        yield* sql`update threads set task_id = ${e.taskId}, route = ${JSON.stringify(e.route)},
            session_id = case when json_extract(route, '$.harness') = ${e.route.harness} then session_id end
          where id = ${e.threadId}`;
        if (e.decision)
          yield* sql`insert into route_decisions (task_id, source, task_class, reason, payload, decided_at)
            values (${e.taskId}, ${e.decision.source}, ${e.decision.taskClass}, ${e.decision.reason}, ${JSON.stringify(e.decision)}, ${at})`;
      }),
    ),
  // Tasks started at or before `seq` no longer count toward the project's routing memory.
  "routing.memory.cleared": (e, at, seq) =>
    withSql(
      (sql) =>
        sql`insert into routing_memory (project_id, cleared_seq, cleared_at) values (${e.projectId}, ${seq}, ${at})
            on conflict (project_id) do update set cleared_seq = excluded.cleared_seq, cleared_at = excluded.cleared_at`,
    ),
  "task.rated": (e) => withSql((sql) => sql`update tasks set rating = ${e.rating} where id = ${e.taskId}`),
  "thread.archived": (e, at) => withSql((sql) => sql`update threads set archived_at = ${at} where id = ${e.threadId}`),
  "thread.unarchived": (e) => withSql((sql) => sql`update threads set archived_at = null where id = ${e.threadId}`),
  "thread.route.unpinned": (e) => withSql((sql) => sql`update threads set pinned = 0, task_id = null where id = ${e.threadId}`),
  // A routed thread's task ends, so the next turn is routed under the new mode; a pinned thread's task keeps its pin.
  "thread.budget.changed": (e) =>
    withSql(
      (sql) => sql`update threads set budget_mode = ${e.mode}, task_id = case when pinned = 1 then task_id end where id = ${e.threadId}`,
    ),
  "turn.started": (e, at) =>
    Effect.andThen(
      withSql((sql) =>
        Effect.andThen(
          sql`insert into turns (id, thread_id, text, mode, attachments, status, started_at)
            values (${e.turnId}, ${e.threadId}, ${e.text}, ${e.mode ?? "build"}, ${JSON.stringify(e.attachments ?? [])}, 'running', ${at})`,
          // A new turn closes the latest revert's undo window.
          sql`update threads set running_turn_id = ${e.turnId}, revert = null where id = ${e.threadId}`,
        ),
      ),
      indexMessage(e.threadId, e.turnId, "user", e.text, at),
    ),
  // A revert's fork drops its reverted turns from the session; any other new session starts with the running turn.
  "harness.session.bound": (e) =>
    withSql((sql) =>
      Effect.andThen(
        sql`update turns set reverted = 2 where thread_id = ${e.threadId} and reverted = 1
              and (select pending_fork from threads where id = ${e.threadId}) is not null`,
        sql`update threads set session_id = ${e.sessionId}, transcript_path = ${e.transcriptPath ?? null}, pending_fork = null,
              session_first_turn = case when pending_fork is null and session_id is not ${e.sessionId} then running_turn_id
                else session_first_turn end
            where id = ${e.threadId}`,
      ),
    ),
  // The next turn forks the session at `toTurnId`, dropping the turns after it still in the session.
  "thread.reverted": (e) =>
    withSql((sql) =>
      Effect.gen(function* () {
        const [thread] = yield* sql<{ pending_fork: string | null }>`select pending_fork from threads where id = ${e.threadId}`;
        const drop = yield* sql<{ id: TurnId }>`
          select id from turns where thread_id = ${e.threadId} and reverted != 2
            and (started_at, rowid) > (select started_at, rowid from turns where id = ${e.toTurnId})
          order by started_at, rowid`;
        yield* sql`update turns set reverted = 1 where id in (select value from json_each(${JSON.stringify(e.turnIds)}))`;
        const revert: StoredRevert = {
          toTurnId: e.toTurnId,
          turnIds: e.turnIds,
          files: e.files,
          undone: false,
          prevFork: thread?.pending_fork ?? null,
        };
        const fork = { atTurnId: e.toTurnId, dropTurnIds: drop.map((t) => t.id) };
        yield* sql`update threads set task_id = null, pending_fork = ${JSON.stringify(fork)}, revert = ${JSON.stringify(revert)}
          where id = ${e.threadId}`;
      }),
    ),
  "thread.revert.undone": (e) =>
    withSql((sql) =>
      Effect.andThen(
        sql`update turns set reverted = 0 where id in (select value from json_each(${JSON.stringify(e.turnIds)}))`,
        sql`update threads set pending_fork = json_extract(revert, '$.prevFork'), revert = json_set(revert, '$.undone', json('true'))
            where id = ${e.threadId}`,
      ),
    ),
  // Saving what the store has confirms that entry: same id, new text and time. Consolidation drops what it replaces.
  "memory.saved": (e, at) =>
    withSql((sql) =>
      Effect.andThen(
        sql`delete from memories where entry_id in (select value from json_each(${JSON.stringify(e.replaces)})) and entry_id != ${e.entryId}`,
        sql`insert into memories (entry_id, scope, project_id, text, source_thread, source_turn, saved_at, confirmed_at)
            values (${e.entryId}, ${e.scope}, ${e.projectId ?? null}, ${e.text}, ${e.threadId}, ${e.turnId ?? null}, ${at}, ${at})
            on conflict (entry_id) do update set text = excluded.text, confirmed_at = excluded.confirmed_at`,
      ),
    ),
  "memory.edited": (e, at) =>
    withSql((sql) => sql`update memories set text = ${e.text}, confirmed_at = ${at} where entry_id = ${e.entryId}`),
  "memory.deleted": (e) => withSql((sql) => sql`delete from memories where entry_id = ${e.entryId}`),
  "memory.snapshot.taken": (e) =>
    withSql(
      (sql) => sql`update threads set memory_snapshot = ${JSON.stringify({ turnId: e.turnId, text: e.text })} where id = ${e.threadId}`,
    ),
  "task.blocked": (e) => addItem(e.turnId, { kind: "blocked", reason: e.reason }),
  "injection.flagged": (e) => addItem(e.turnId, injectionItem(e)),
  "thread.files.restored": (e) =>
    withSql(
      (sql) =>
        sql`update threads set revert = json_set(revert, '$.saved', ${e.saved ?? null}, '$.filesError', ${e.error ?? null})
            where id = ${e.threadId} and revert is not null`,
    ),
  // Git holds checkpoints (ADR 0015); the event only records what the cleanup policy removed.
  "thread.checkpoints.removed": () => Effect.void,
  // The main agent's replies are searchable; tool output and subagents' steps aren't (ADR 0006).
  "turn.item.added": (e, at) =>
    Effect.andThen(
      addItem(e.turnId, e.item),
      e.item.kind === "assistant.message" && e.item.parentToolUseId === undefined
        ? indexMessage(e.threadId, e.turnId, "assistant", e.item.text, at)
        : Effect.void,
    ),
  "turn.steered": (e, at) =>
    Effect.andThen(addItem(e.turnId, { kind: "user.steer", text: e.text }), indexMessage(e.threadId, e.turnId, "steer", e.text, at)),
  "turn.usage.recorded": (e, at) =>
    withSql(
      (sql) =>
        sql`insert into usage_ledger (turn_id, model, access_mode, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, at)
            values (${e.turnId}, ${e.model}, ${e.accessMode}, ${e.inputTokens}, ${e.outputTokens}, ${e.cacheReadTokens}, ${e.cacheWriteTokens}, ${e.costUsd}, ${at})`,
    ),
  "harness.quota.reported": (e, at) =>
    withSql(
      (sql) =>
        sql`insert into quota (harness, payload, at) values (${e.harness}, ${JSON.stringify(e.quota)}, ${at})
            on conflict (harness) do update set payload = excluded.payload, at = excluded.at`,
    ),
  "approval.requested": insertRequest,
  "user-input.requested": insertRequest,
  "plan.requested": (e, at) =>
    Effect.andThen(
      addItem(e.turnId, {
        kind: "plan",
        requestId: e.requestId,
        text: e.plan,
        ...(e.filePath === undefined ? {} : { filePath: e.filePath }),
      }),
      insertRequest(e, at),
    ),
  // The task's decision becomes the one it runs on now, so the route chip and `RoutingExplain` match the route.
  "task.rerouted": (e) =>
    Effect.andThen(
      withSql((sql) =>
        Effect.andThen(
          sql`update threads set route = ${JSON.stringify(e.to)} where id = ${e.threadId}`,
          sql`update route_decisions set source = ${e.decision.source}, task_class = ${e.decision.taskClass},
              reason = ${e.decision.reason}, payload = ${JSON.stringify(e.decision)} where task_id = ${e.taskId}`,
        ),
      ),
      addItem(e.turnId, { kind: "route.switch", from: e.from, to: e.to, reason: e.decision.reason }),
    ),
  // The task goes on at `to`, on the same harness, so the session carries over; at `ask` nothing moves.
  "task.escalated": (e) =>
    Effect.andThen(
      e.to
        ? withSql((sql) =>
            Effect.andThen(
              sql`update threads set route = ${JSON.stringify(e.to)} where id = ${e.threadId}`,
              sql`update tasks set escalations = escalations + 1 where id = ${e.taskId}`,
            ).pipe(
              // The route chip explains the route the task runs on now; the decision itself stays as routed.
              Effect.andThen(sql`update route_decisions set reason = ${e.reason} where task_id = ${e.taskId}`),
            ),
          )
        : Effect.void,
      addItem(e.turnId, {
        kind: "escalation",
        step: e.step,
        from: e.from,
        ...(e.to && { to: e.to }),
        ...(e.nextTurnId && { nextTurnId: e.nextTurnId }),
        reason: e.reason,
      }),
    ),
  // The task goes on at `to` from the turn committed next, on the same harness and session, and stays routed. Shown between
  // the turns like the user's route changes; the route chip explains the route it runs on now, and the decision stays as routed.
  "task.deescalated": (e, at, seq) =>
    withSql((sql) =>
      Effect.all([
        sql`update threads set route = ${JSON.stringify(e.to)} where id = ${e.threadId}`,
        sql`update route_decisions set reason = ${e.decision.reason} where task_id = ${e.taskId}`,
        sql`insert into route_changes (seq, thread_id, from_route, to_route, by, after_turns, at, reason)
            values (${seq}, ${e.threadId}, ${JSON.stringify(e.from)}, ${JSON.stringify(e.to)}, 'router',
              (select count(*) from turns where thread_id = ${e.threadId}), ${at}, ${e.decision.reason})`,
      ]),
    ),
  "thread.worktree.requested": projectWorktree,
  "thread.worktree.created": projectWorktree,
  "thread.worktree.failed": projectWorktree,
  "thread.worktree.setup.ran": projectWorktree,
  "thread.worktree.removal.requested": projectWorktree,
  "thread.worktree.removed": projectWorktree,
  "verifiers.started": (e) => withSql((sql) => sql`update turns set verifying = 1 where id = ${e.turnId}`),
  "verifier.ran": ({ type: _, v: _v, threadId: _t, turnId, ...run }) => addItem(turnId, { kind: "verifier", ...run }),
  // A plan approved with the user's edit keeps both versions on its item.
  "approval.resolved": (e, at) =>
    withSql((sql) =>
      Effect.andThen(
        sql`update requests set resolution = ${JSON.stringify(e.resolution)}, reason = ${e.reason ?? null}, resolved_at = ${at}
            where id = ${e.requestId}`,
        e.resolution.decision === "allow" && e.resolution.plan !== undefined
          ? sql`update items set payload = json_set(payload, '$.edited', ${e.resolution.plan})
                where turn_id = ${e.turnId} and json_extract(payload, '$.requestId') = ${e.requestId}`.pipe(Effect.asVoid)
          : Effect.void,
      ),
    ),
  "decision.recorded": (e, at, seq) =>
    withSql((sql) =>
      Effect.forEach(
        e.answers,
        (a, idx) =>
          sql`insert into decisions (seq, idx, thread_id, turn_id, kind, question, answer, confidence, low_confidence, backend, decided_at)
            values (${seq}, ${idx}, ${e.threadId}, ${e.turnId}, ${a.kind}, ${JSON.stringify(e.questions[idx] ?? null)}, ${JSON.stringify(a)},
              ${a.confidence}, ${a.lowConfidence ? 1 : 0}, ${a.backend}, ${at})`,
        { discard: true },
      ),
    ),
  // A turn a budget guard stopped ends its task, so the next turn starts a new one.
  "turn.completed": (e, at) =>
    withSql((sql) =>
      Effect.andThen(
        sql`update turns set status = ${e.status}, error = ${e.error ?? null}, completed_at = ${at} where id = ${e.turnId}`,
        sql`update threads set running_turn_id = null, task_id = case when ${e.status} = 'limit' then null else task_id end
            where id = ${e.threadId} and running_turn_id = ${e.turnId}`,
      ),
    ),
  "spend.cap.raised": (e, at, seq) =>
    withSql(
      (sql) =>
        sql`insert into spend_cap_raises (seq, scope, project_id, period, period_key, limit_usd, at)
            values (${seq}, ${e.scope}, ${e.projectId ?? null}, ${e.period}, ${e.periodKey}, ${e.toUsd}, ${at})`,
    ),
};

/** Applies one event to the read models. Runs inside the engine's transaction. */
export const project = (stored: StoredEvent) =>
  (projections[stored.event.type] as Projection<Event["type"]>)(stored.event, stored.at, stored.seq).pipe(Effect.asVoid);

/** The thread's tasks and their ratings, oldest first. */
const loadTasks = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{ id: TaskId; rating: TaskRating | null }>`select id, rating from tasks where thread_id = ${threadId} order by seq`.pipe(
    Effect.map((rows) => rows.map((r) => ({ taskId: r.id, rating: r.rating }))),
  );

export const loadDeciderState = (threadId: ThreadId): Effect.Effect<DeciderState, SqlError.SqlError, SqlClient.SqlClient> =>
  withSql((sql) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{
        project_id: ProjectId;
        path: string;
        route: string;
        running_turn_id: string | null;
        verifying: number | null;
        session_id: string | null;
        task_id: TaskId | null;
        pinned: number;
        archived: number;
        budget_mode: BudgetMode | null;
        turns: number;
        last_turn_id: TurnId | null;
        task_escalations: number;
        last_turn_verified: number;
        task_decision: string | null;
        task_mode: string | null;
        cached_tokens: number;
        worktree: string | null;
        pending_fork: number;
        session_first_turn: TurnId | null;
        revert: string | null;
      }>`
        select t.project_id, p.path, t.route, t.running_turn_id, t.session_id,
          (select verifying from turns where id = t.running_turn_id) as verifying, t.task_id, t.pinned, t.budget_mode, t.worktree,
          t.pending_fork is not null as pending_fork, t.session_first_turn, t.revert,
          t.archived_at is not null as archived,
          (select count(*) from turns n where n.thread_id = t.id) as turns,
          (select id from turns n where n.thread_id = t.id order by started_at desc, rowid desc limit 1) as last_turn_id,
          coalesce((select escalations from tasks where id = t.task_id), 0) as task_escalations,
          -- The latest turn succeeded, and ran verifiers that all passed.
          coalesce((select n.status = 'success'
              and exists (select 1 from items i where i.turn_id = n.id and json_extract(i.payload, '$.kind') = 'verifier')
              and not exists (select 1 from items i where i.turn_id = n.id and json_extract(i.payload, '$.kind') = 'verifier'
                and not json_extract(i.payload, '$.passed'))
            from turns n where n.thread_id = t.id order by n.started_at desc, n.rowid desc limit 1), 0) as last_turn_verified,
          (select payload from route_decisions where task_id = t.task_id) as task_decision,
          (select mode from turns where id = t.task_id) as task_mode,
          -- ponytail: the context a warm session has cached, read as every token the thread wrote to cache. Harnesses
          -- report usage summed over a turn's model calls, not the context size; upgrade once one reports that.
          (select coalesce(sum(u.cache_write_tokens), 0) from usage_ledger u join turns n on n.id = u.turn_id where n.thread_id = t.id)
            as cached_tokens
        from threads t join projects p on p.id = t.project_id where t.id = ${threadId}`;
      if (!row) return { thread: undefined };
      const pending = yield* sql<{
        id: string;
        turn_id: string;
        kind: PendingRequest["kind"];
        plan: string | null;
        execute: string | null;
      }>`
        select id, turn_id, kind, json_extract(payload, '$.plan') as plan, json_extract(payload, '$.execute') as execute
        from requests where thread_id = ${threadId} and resolution is null`;
      const turnList = yield* sql<{ id: TurnId; reverted: 0 | 1 | 2 }>`
        select id, reverted from turns where thread_id = ${threadId} order by started_at, rowid`;
      return {
        thread: {
          tasks: yield* loadTasks(sql, threadId),
          turnList: turnList.map((t) => ({ turnId: t.id, reverted: t.reverted })),
          pendingFork: row.pending_fork === 1,
          sessionFirstTurn: row.session_first_turn,
          revert: row.revert === null ? null : (JSON.parse(row.revert) as StoredRevert),
          projectId: row.project_id,
          projectPath: row.path,
          route: JSON.parse(row.route) as Route,
          runningTurnId: row.running_turn_id,
          verifying: row.verifying === 1,
          sessionId: row.session_id,
          taskId: row.task_id,
          turns: row.turns,
          lastTurnId: row.last_turn_id,
          taskEscalations: row.task_escalations,
          lastTurnVerified: row.last_turn_verified === 1,
          pinned: row.pinned === 1,
          archived: row.archived === 1,
          worktree: row.worktree === null ? null : (JSON.parse(row.worktree) as WorktreeView),
          budgetMode: row.budget_mode,
          taskDecision: row.task_decision === null ? null : (JSON.parse(row.task_decision) as RouteDecision),
          taskPlanned: row.task_mode === "plan",
          cachedTokens: row.cached_tokens,
          pendingRequests: pending.map((r) => ({
            requestId: r.id,
            turnId: r.turn_id as TurnId,
            kind: r.kind,
            ...(r.plan === null ? {} : { plan: r.plan }),
            ...(r.execute === null ? {} : { execute: JSON.parse(r.execute) as RouteDecision }),
          })),
        },
      };
    }),
  );

export const loadThreadView = (threadId: ThreadId): Effect.Effect<ThreadView | null, SqlError.SqlError, SqlClient.SqlClient> =>
  withSql((sql) =>
    Effect.gen(function* () {
      const [thread] = yield* sql<{
        path: string;
        route: string;
        session_id: string | null;
        running_turn_id: string | null;
        pinned: number;
        archived: number;
        budget_mode: BudgetMode | null;
        task_id: TaskId | null;
        source: RouteDecision["source"] | null;
        reason: string | null;
        worktree: string | null;
        revert: string | null;
      }>`
        select p.path, t.route, t.session_id, t.running_turn_id, t.pinned, t.archived_at is not null as archived, t.budget_mode, t.worktree,
          t.revert,
          t.task_id, d.source, d.reason
        from threads t join projects p on p.id = t.project_id left join route_decisions d on d.task_id = t.task_id
        where t.id = ${threadId}`;
      if (!thread) return null;
      const turns = yield* sql<{
        id: string;
        text: string;
        mode: TurnView["mode"];
        attachments: string;
        status: TurnView["status"];
        error: string | null;
        reverted: number;
      }>`
        select id, text, mode, attachments, status, error, reverted from turns where thread_id = ${threadId} order by started_at, rowid`;
      const items = yield* sql<{ turn_id: string; payload: string }>`
        select i.turn_id, i.payload from items i join turns t on t.id = i.turn_id where t.thread_id = ${threadId} order by i.turn_id, i.idx`;
      const itemsByTurn = Map.groupBy(items, (i) => i.turn_id);
      const usage = yield* sql<{
        turn_id: string;
        model: string;
        access_mode: Usage["accessMode"];
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        cost_usd: number;
      }>`
        select u.* from usage_ledger u join turns t on t.id = u.turn_id where t.thread_id = ${threadId} order by u.rowid`;
      const usageByTurn = Map.groupBy(usage, (u) => u.turn_id);
      const pending = yield* sql<{ payload: string }>`
        select payload from requests where thread_id = ${threadId} and resolution is null order by requested_at, rowid`;
      const routeChanges = yield* sql<{
        from_route: string;
        to_route: string;
        by: RouteChange["by"];
        after_turns: number;
        at: string;
        reason: string | null;
      }>`
        select from_route, to_route, by, after_turns, at, reason from route_changes where thread_id = ${threadId} order by seq`;
      return {
        threadId,
        projectPath: thread.path,
        route: JSON.parse(thread.route) as Route,
        pinned: thread.pinned === 1,
        archived: thread.archived === 1,
        budgetMode: thread.budget_mode,
        task:
          thread.task_id === null
            ? null
            : {
                taskId: thread.task_id,
                ...(thread.source === null ? {} : { source: thread.source }),
                ...(thread.reason === null ? {} : { reason: thread.reason }),
              },
        tasks: yield* loadTasks(sql, threadId),
        sessionId: thread.session_id,
        worktree: thread.worktree === null ? null : (JSON.parse(thread.worktree) as WorktreeView),
        revert: revertView(thread.revert),
        busy: thread.running_turn_id !== null,
        turns: turns.map(
          (t): TurnView => ({
            turnId: t.id as TurnView["turnId"],
            text: t.text,
            mode: t.mode,
            attachments: JSON.parse(t.attachments) as AttachmentRef[],
            status: t.status,
            reverted: t.reverted !== 0,
            items: (itemsByTurn.get(t.id) ?? []).map((i) => JSON.parse(i.payload) as Item),
            usage: (usageByTurn.get(t.id) ?? []).map((u) => ({
              model: u.model,
              accessMode: u.access_mode,
              inputTokens: u.input_tokens,
              outputTokens: u.output_tokens,
              cacheReadTokens: u.cache_read_tokens,
              cacheWriteTokens: u.cache_write_tokens,
              costUsd: u.cost_usd,
            })),
            ...(t.error === null ? {} : { error: t.error }),
          }),
        ),
        routeChanges: routeChanges.map((r) => ({
          from: JSON.parse(r.from_route) as Route,
          to: JSON.parse(r.to_route) as Route,
          by: r.by,
          at: r.at,
          afterTurns: r.after_turns,
          ...(r.reason === null ? {} : { reason: r.reason }),
        })),
        pendingRequests: pending.map((r) => JSON.parse(r.payload) as ThreadView["pendingRequests"][number]),
      };
    }),
  );

/** A thread's title until auto-titling exists: the first line of its first turn, cut to 80 characters. */
export const titleFrom = (text: string) => clip(text.trim().split(/\r?\n/, 1)[0] ?? "", 80);

export const loadProjects: Effect.Effect<ProjectSummary[], SqlError.SqlError, SqlClient.SqlClient> = withSql((sql) =>
  sql<{ id: string; path: string }>`select id, path from projects order by path`.pipe(
    Effect.map((rows) => rows.map((r) => ({ projectId: r.id as ProjectId, path: r.path }))),
  ),
);

/** Each harness's latest subscription window. */
export const loadQuotas: Effect.Effect<QuotaView[], SqlError.SqlError, SqlClient.SqlClient> = withSql((sql) =>
  sql<{ harness: QuotaView["harness"]; payload: string; at: string }>`select harness, payload, at from quota order by harness`.pipe(
    Effect.map((rows) => rows.map((r) => ({ harness: r.harness, quota: JSON.parse(r.payload) as Quota, at: r.at }))),
  ),
);

/** Summaries of every thread, most recently active first, or of just `threadId`. Archived threads only with `archived`. */
export const loadThreadSummaries = (
  threadId?: ThreadId,
  archived = true,
): Effect.Effect<ThreadSummary[], SqlError.SqlError, SqlClient.SqlClient> =>
  withSql((sql) =>
    sql<{
      id: string;
      project_id: string;
      route: string;
      running_turn_id: string | null;
      archived: number;
      first_text: string | null;
      last_activity_at: string;
      metered_usd: number;
      subscription_usd: number;
    }>`
      select t.id, t.project_id, t.route, t.running_turn_id, t.archived_at is not null as archived,
        (select text from turns where thread_id = t.id order by started_at, rowid limit 1) as first_text,
        (select total(u.cost_usd) from turns tu join usage_ledger u on u.turn_id = tu.id
          where tu.thread_id = t.id and u.access_mode = 'metered') as metered_usd,
        (select total(u.cost_usd) from turns tu join usage_ledger u on u.turn_id = tu.id
          where tu.thread_id = t.id and u.access_mode = 'subscription') as subscription_usd,
        coalesce((select max(coalesce(completed_at, started_at)) from turns where thread_id = t.id), t.created_at) as last_activity_at
      from threads t
      where (${threadId ?? null} is null or t.id = ${threadId ?? null}) and (${archived ? 1 : 0} = 1 or t.archived_at is null)
      order by last_activity_at desc, t.rowid desc`.pipe(
      Effect.map((rows) =>
        rows.map((r) => ({
          threadId: r.id as ThreadId,
          projectId: r.project_id as ProjectId,
          title: titleFrom(r.first_text ?? ""),
          busy: r.running_turn_id !== null,
          archived: r.archived === 1,
          lastActivityAt: r.last_activity_at,
          route: JSON.parse(r.route) as Route,
          cost: { meteredUsd: r.metered_usd, subscriptionUsd: r.subscription_usd },
        })),
      ),
    ),
  );

/** The thread's user and project memory, most recently confirmed first. */
export const loadMemory = (threadId: ThreadId): Effect.Effect<MemoryView | null, SqlError.SqlError, SqlClient.SqlClient> =>
  withSql((sql) =>
    Effect.gen(function* () {
      const [thread] = yield* sql<{ project_id: ProjectId; path: string }>`
        select t.project_id, p.path from threads t join projects p on p.id = t.project_id where t.id = ${threadId}`;
      if (!thread) return null;
      const rows = yield* sql<{
        entry_id: string;
        scope: MemoryScope;
        text: string;
        source_thread: ThreadId;
        source_turn: TurnId | null;
        saved_at: string;
        confirmed_at: string;
      }>`
        select entry_id, scope, text, source_thread, source_turn, saved_at, confirmed_at from memories
        where scope = 'user' or project_id = ${thread.project_id} order by confirmed_at desc, rowid desc`;
      const entries = rows.map(
        (r): MemoryEntry => ({
          entryId: r.entry_id,
          scope: r.scope,
          text: r.text,
          source: { threadId: r.source_thread, ...(r.source_turn === null ? {} : { turnId: r.source_turn }) },
          savedAt: r.saved_at,
          confirmedAt: r.confirmed_at,
        }),
      );
      return {
        projectPath: thread.path,
        user: entries.filter((e) => e.scope === "user"),
        project: entries.filter((e) => e.scope === "project"),
      };
    }),
  );
