import type { Command, GatewaySender, GatewayView, PendingPairing, Platform } from "@verdandi/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { AccessState } from "./access.ts";

/** Reads of the gateway's read models (`gateway_pairings`, `gateway_senders`, `gateway_owners`). */

/** Pairing requests that wait and haven't expired by `now`, oldest first, with their code's hash and salt. */
export const loadPending = (now: Date) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<PendingPairing & { readonly chatId: string; readonly codeHash: string; readonly salt: string }>`
      select request_id as requestId, platform, chat_id as chatId, sender_id as senderId, sender_name as senderName,
        requested_at as at, expires_at as expiresAt, code_hash as codeHash, salt
      from gateway_pairings where answer is null and expires_at > ${now.toISOString()} order by requested_at`,
  );

/** What the access module needs to know about `senderId` on `platform`. */
export const loadAccessState = (platform: Platform, senderId: string, now: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [owner] = yield* sql<{ senderId: string }>`select sender_id as senderId from gateway_owners where platform = ${platform}`;
    const paired = yield* sql<{ senderId: string }>`
      select sender_id as senderId from gateway_senders where platform = ${platform} and revoked_at is null`;
    const pending = (yield* loadPending(now)).filter((p) => p.platform === platform).length;
    const [last] = yield* sql<{ at: string | null }>`
      select max(requested_at) as at from gateway_pairings where platform = ${platform} and sender_id = ${senderId}`;
    return {
      owner: owner?.senderId ?? null,
      paired: paired.map((p) => p.senderId),
      pending,
      lastRequestAt: last?.at ?? null,
    } satisfies AccessState;
  });

/** The view the web UI, the terminal chat's notice and `verdandi gateway senders` show. */
export const loadGatewayView = (now: Date, running: readonly Platform[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const pending = (yield* loadPending(now)).map(
      ({ requestId, platform, senderId, senderName, at, expiresAt }): PendingPairing => ({
        requestId,
        platform,
        senderId,
        senderName,
        at,
        expiresAt,
      }),
    );
    const rows = yield* sql<{ platform: Platform; senderId: string; name: string; pairedAt: string | null; owner: number }>`
      select s.platform, s.sender_id as senderId, s.name, s.paired_at as pairedAt,
        exists (select 1 from gateway_owners o where o.platform = s.platform and o.sender_id = s.sender_id) as owner
      from gateway_senders s where s.revoked_at is null
      union all
      select o.platform, o.sender_id, o.sender_id, null, 1 from gateway_owners o
      where not exists (select 1 from gateway_senders s where s.platform = o.platform and s.sender_id = o.sender_id and s.revoked_at is null)
      order by 1, 4`;
    const senders = rows.map((r): GatewaySender => ({ ...r, owner: r.owner === 1 }));
    return { pending, senders, running: [...running] } satisfies GatewayView;
  });

/** What the decider needs for a gateway command, read as of `now`: a waiting pairing request expires after its hour. */
export const loadGatewayDeciderState = (command: Command, now: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (command.type === "pairing.approve" || command.type === "pairing.deny") {
      const [pairing] = yield* sql<{ platform: Platform; chatId: string; senderId: string; senderName: string }>`
        select platform, chat_id as chatId, sender_id as senderId, sender_name as senderName from gateway_pairings
        where request_id = ${command.requestId} and answer is null and expires_at > ${now.toISOString()}`;
      return { pairing: pairing ?? null };
    }
    if (command.type === "sender.revoke") {
      const paired = yield* sql`
        select 1 from gateway_senders where platform = ${command.platform} and sender_id = ${command.senderId} and revoked_at is null`;
      const owner = yield* sql`select 1 from gateway_owners where platform = ${command.platform} and sender_id = ${command.senderId}`;
      return { gatewaySender: { paired: paired.length > 0, owner: owner.length > 0 } };
    }
    return {};
  });
