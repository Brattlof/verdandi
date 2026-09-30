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

export const migrations = { "1_init": init, "2_requests": requests, "3_turn_modes": turnModes, "4_trajectories": trajectories };
