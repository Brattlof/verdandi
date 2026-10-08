import type { AccessLevel, Route, ThreadId, TurnId, UntrustedInput } from "@verdandi/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { sessionUntrusted } from "../routing/untrusted.ts";

export type Access = { readonly level: AccessLevel; readonly held?: string };

/**
 * The access level a thread's agent works at now (DESIGN §17, ADR 0025): the one the user set, else the profile's; but
 * `ask` in a thread someone else can write in, and `auto` for a `full` session that has read untrusted input, saying why
 * in `held`. Pure.
 */
export const effectiveAccess = (
  thread: { readonly access: AccessLevel | null; readonly confined: boolean; readonly untrusted: UntrustedInput | null },
  profile: AccessLevel,
): Access => {
  if (thread.confined) return { level: "ask" };
  const level = thread.access ?? profile;
  if (level === "full" && thread.untrusted)
    return {
      level: "auto",
      held: `full access holds at auto: this session read ${thread.untrusted.source} in turn ${thread.untrusted.turn}`,
    };
  return { level };
};

/** `effectiveAccess` for `threadId` from the read models, counting the running turn's untrusted input before its session is bound. */
export const loadAccess = (threadId: ThreadId, profile: AccessLevel) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [thread] = yield* sql<{
      access: AccessLevel | null;
      confined: number;
      route: string;
      session_id: string | null;
      session_first_turn: TurnId | null;
      running: string | null;
    }>`
      select access, confined, route, session_id, session_first_turn,
        (select untrusted from turns where id = t.running_turn_id) as running
      from threads t where id = ${threadId}`;
    if (!thread) return { level: "ask" } as Access;
    const turns = yield* sql<{ turnId: TurnId; reverted: 0 | 1 | 2; untrusted: string | null }>`
      select id as turnId, reverted, untrusted from turns where thread_id = ${threadId} order by started_at, rowid`;
    const { harness } = JSON.parse(thread.route) as Route;
    const untrusted =
      sessionUntrusted(turns, { harness, sessionId: thread.session_id, sessionFirstTurn: thread.session_first_turn }) ??
      (thread.running === null ? null : { source: thread.running, turn: turns.length });
    return effectiveAccess({ access: thread.access, confined: thread.confined === 1, untrusted }, profile);
  });
