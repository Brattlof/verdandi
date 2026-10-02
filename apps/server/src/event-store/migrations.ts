import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

// Append-only: never edit a migration that has shipped; add the next number instead.

const init = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table events (
    seq integer primary key,
    event_id text unique not null,
    command_id text not null,
    thread_id text not null,
    type text not null,
    v integer not null,
    at text not null,
    payload text not null
  )`;
  yield* sql`create index events_thread on events (thread_id, seq)`;
  yield* sql`create table command_receipts (command_id text primary key, seq integer not null)`;
  yield* sql`create table projects (id text primary key, path text not null)`;
  yield* sql`create table threads (
    id text primary key,
    project_id text not null references projects (id),
    route text not null,
    session_id text,
    running_turn_id text,
    created_at text not null
  )`;
  yield* sql`create table turns (
    id text primary key,
    thread_id text not null references threads (id),
    text text not null,
    status text not null,
    error text,
    started_at text not null,
    completed_at text
  )`;
  yield* sql`create index turns_thread on turns (thread_id, started_at)`;
  yield* sql`create table items (turn_id text not null references turns (id), idx integer not null, payload text not null, primary key (turn_id, idx))`;
  yield* sql`create table usage_ledger (
    turn_id text not null references turns (id),
    model text not null,
    access_mode text not null,
    input_tokens integer not null,
    output_tokens integer not null,
    cache_read_tokens integer not null,
    cache_write_tokens integer not null,
    cost_usd real not null,
    at text not null
  )`;
});

/** Approval and user-input requests; `resolution` is null while one is pending. */
const requests = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table requests (
    id text primary key,
    thread_id text not null references threads (id),
    turn_id text not null references turns (id),
    kind text not null,
    payload text not null,
    resolution text,
    reason text,
    requested_at text not null,
    resolved_at text
  )`;
  yield* sql`create index requests_pending on requests (thread_id) where resolution is null`;
});

/** Each turn's interaction mode; turns from before modes existed ran as build. */
const turnModes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table turns add column mode text not null default 'build'`;
});

/** One redacted trajectory per completed turn, written by the reactor (DESIGN §14.6). `provider` is for the terms check (§14.8). */
const trajectories = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table trajectories (
    turn_id text primary key references turns (id),
    thread_id text not null references threads (id),
    provider text not null,
    payload text not null,
    recorded_at text not null
  )`;
});

/**
 * Each thread's route changes, placed between turns by `after_turns`: how many turns had started.
 * Filled from the route changes already in the event log.
 */
const routeChanges = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table route_changes (
    seq integer primary key,
    thread_id text not null references threads (id),
    from_route text not null,
    to_route text not null,
    by text not null,
    after_turns integer not null,
    at text not null
  )`;
  yield* sql`create index route_changes_thread on route_changes (thread_id, seq)`;
  yield* sql`insert into route_changes (seq, thread_id, from_route, to_route, by, after_turns, at)
    select e.seq, e.thread_id, json_extract(e.payload, '$.from'), json_extract(e.payload, '$.to'), json_extract(e.payload, '$.by'),
      (select count(*) from events s where s.thread_id = e.thread_id and s.type = 'turn.started' and s.seq < e.seq), e.at
    from events e where e.type = 'thread.route.changed'`;
});

/** Each harness's latest subscription window (ADR 0005), and an index so a thread's cost totals read only its own usage. */
const quota = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table quota (harness text primary key, payload text not null, at text not null)`;
  yield* sql`create index usage_ledger_turn on usage_ledger (turn_id)`;
});

/**
 * Tasks (DESIGN §7) and their outcomes (§8.8). `threads.task_id` is the task the next turn continues.
 * Turns from before tasks existed belong to none; a thread's next turn starts its first.
 * `task_outcomes` is written by the reactor; `seq` is the last thread event the outcome was built from.
 */
const tasks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table tasks (
    id text primary key,
    thread_id text not null references threads (id),
    route text not null,
    seq integer not null,
    started_at text not null
  )`;
  yield* sql`create index tasks_thread on tasks (thread_id, seq)`;
  yield* sql`alter table threads add column task_id text`;
  yield* sql`create table task_outcomes (
    task_id text primary key references tasks (id),
    status text not null,
    cost_usd real not null,
    payload text not null,
    seq integer not null,
    recorded_at text not null
  )`;
});

/**
 * Routing (DESIGN §8.4): each task's decision, and whether the user pinned the thread's route. Threads
 * from before routing always ran on the route the user sent, so they stay pinned.
 */
const routeDecisions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table route_decisions (
    task_id text primary key references tasks (id),
    source text not null,
    task_class text not null,
    reason text not null,
    payload text not null,
    decided_at text not null
  )`;
  yield* sql`alter table threads add column pinned integer not null default 1`;
});

/** The budget mode the user set for a thread's tasks (DESIGN §8.3); null uses the policy's. */
const budgetMode = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table threads add column budget_mode text`;
});

/**
 * Every answer the decision layer gave (DESIGN §9.8), one row per question, for the lab to measure other
 * backends against. The state is the text of `turn_id`'s turn, kept only there; the decision is recorded
 * right before that turn starts, so `turn_id` has no foreign key.
 */
const decisions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table decisions (
    seq integer not null,
    idx integer not null,
    thread_id text not null references threads (id),
    turn_id text not null,
    kind text not null,
    question text not null,
    answer text not null,
    confidence real not null,
    low_confidence integer not null,
    backend text not null,
    decided_at text not null,
    primary key (seq, idx)
  )`;
  yield* sql`create index decisions_kind on decisions (kind, backend)`;
});

/** Spend caps the user raised for the rest of a period (DESIGN §8.9); `project_id` is null for the profile's. */
const spendCapRaises = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table spend_cap_raises (
    seq integer primary key,
    scope text not null,
    project_id text,
    period text not null,
    period_key text not null,
    limit_usd real not null,
    at text not null
  )`;
  yield* sql`create index usage_ledger_at on usage_ledger (at)`;
});

/** When each project's routing memory was last cleared (DESIGN §8.8): only tasks started after `cleared_seq` count. */
const routingMemory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table routing_memory (
    project_id text primary key references projects (id),
    cleared_seq integer not null,
    cleared_at text not null
  )`;
});

/** When the user archived each thread (DESIGN §7); null while it's in the thread lists. */
const threadArchive = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table threads add column archived_at text`;
});

/** Each turn's attachments, as a JSON array of references to their stored bytes (DESIGN §12). */
const turnAttachments = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table turns add column attachments text not null default '[]'`;
});

/** How many escalation steps each task has taken (DESIGN §8.7). */
const taskEscalations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table tasks add column escalations integer not null default 0`;
});

/** Each thread's git worktree (DESIGN §13), as its `WorktreeView` JSON; null when it runs in the project folder. */
const threadWorktree = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table threads add column worktree text`;
});

/**
 * Reverting a thread (DESIGN §13, ADR 0004). `turns.reverted`: 0 shown, 1 reverted but still in the harness
 * session, 2 forked away. On threads: the fork the next turn makes, the turn the current session started
 * with (null: the whole thread), the session's transcript, and the latest revert as JSON until the next turn.
 */
const revert = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table turns add column reverted integer not null default 0`;
  yield* sql`alter table threads add column pending_fork text`;
  yield* sql`alter table threads add column session_first_turn text`;
  yield* sql`alter table threads add column transcript_path text`;
  yield* sql`alter table threads add column revert text`;
  yield* sql`update threads set transcript_path = (
    select json_extract(e.payload, '$.transcriptPath') from events e
    where e.thread_id = threads.id and e.type = 'harness.session.bound' order by e.seq desc limit 1)`;
});

/**
 * Session search (DESIGN §14.3, ADR 0006): every user message, steer and main-agent reply, by thread and turn,
 * in an FTS5 trigram index. Filled from the event log; tool output isn't indexed.
 */
const sessionIndex = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create virtual table session_index using fts5(
    text, thread_id unindexed, turn_id unindexed, kind unindexed, at unindexed,
    tokenize = 'trigram remove_diacritics 1'
  )`;
  yield* sql`insert into session_index (text, thread_id, turn_id, kind, at)
    select coalesce(json_extract(payload, '$.item.text'), json_extract(payload, '$.text')), thread_id, json_extract(payload, '$.turnId'),
      case type when 'turn.started' then 'user' when 'turn.steered' then 'steer' else 'assistant' end, at
    from events
    where type in ('turn.started', 'turn.steered')
      or (type = 'turn.item.added' and json_extract(payload, '$.item.kind') = 'assistant.message'
        and json_extract(payload, '$.item.parentToolUseId') is null)
    order by seq`;
});

/**
 * Memory (DESIGN §14.2): each remembered fact, user-wide (`project_id` null) or a project's, with where it was
 * saved; and on each thread the snapshot its harness session started with, for that session's first turn.
 */
const memory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`create table memories (
    entry_id text primary key,
    scope text not null,
    project_id text,
    text text not null,
    source_thread text not null,
    source_turn text,
    saved_at text not null,
    confirmed_at text not null
  )`;
  yield* sql`create index memories_project on memories (project_id, scope)`;
  yield* sql`alter table threads add column memory_snapshot text`;
});

/** The user's latest rating of each task (DESIGN §8.8): 1, -1, or null for none. */
const taskRatings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`alter table tasks add column rating integer`;
});

export const migrations = {
  "1_init": init,
  "2_requests": requests,
  "3_turn_modes": turnModes,
  "4_trajectories": trajectories,
  "5_route_changes": routeChanges,
  "6_quota": quota,
  "7_tasks": tasks,
  "8_route_decisions": routeDecisions,
  "9_budget_mode": budgetMode,
  "10_decisions": decisions,
  "11_spend_cap_raises": spendCapRaises,
  "12_routing_memory": routingMemory,
  "13_thread_archive": threadArchive,
  "14_turn_attachments": turnAttachments,
  "15_task_escalations": taskEscalations,
  "16_thread_worktree": threadWorktree,
  "17_revert": revert,
  "18_session_index": sessionIndex,
  "19_memory": memory,
  "20_task_ratings": taskRatings,
};
