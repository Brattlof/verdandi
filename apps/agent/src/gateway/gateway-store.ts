import {
  type ChannelBinding,
  type Command,
  type GatewaySender,
  type GatewayView,
  type PendingPairing,
  type Platform,
  profileStream,
  type ThreadId,
  type TurnId,
} from "@verdandi/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { AccessState } from "./access.ts";
import type { DeliveryState } from "./outbox.ts";

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
    if (!("threadId" in command) || command.threadId === profileStream) return {};
    const { threadId } = command;
    const [bound] = yield* sql<{ binding: string }>`select binding from channel_bindings where thread_id = ${threadId}`;
    const binding = bound && (JSON.parse(bound.binding) as ChannelBinding);
    // The running turn's last reply, which its end sends to the chat.
    const ending =
      binding &&
      ((command.type === "harness.report" && command.event.type === "turn.finished") ||
        command.type === "turn.interrupt" ||
        command.type === "turn.recover");
    const reply = ending ? yield* loadLastReply(command.turnId) : undefined;
    const channel = binding && { channel: { threadId, binding, ...(reply !== undefined && { reply }) } };
    if (command.type === "channel.bind") {
      const [key] = yield* sql<{
        threadId: ThreadId;
      }>`select thread_id as threadId from channel_bindings where key = ${command.binding.key}`;
      return { ...channel, binding: { keyThread: key?.threadId ?? null, threadKey: binding?.key ?? null } };
    }
    if (command.type === "delivery.attempt" || command.type === "delivery.report" || command.type === "delivery.abandon") {
      const [delivery] = yield* sql<{ state: DeliveryState; attempts: number; turnId: TurnId }>`
        select state, attempts, turn_id as turnId from deliveries where id = ${command.deliveryId}`;
      return { ...channel, delivery: delivery ?? null };
    }
    return { ...channel };
  });

/** The last thing the main agent said in `turnId`, if it said anything. */
const loadLastReply = (turnId: TurnId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ payload: string }>`
      select payload from items where turn_id = ${turnId} and json_extract(payload, '$.kind') = 'assistant.message'
        and json_extract(payload, '$.parentToolUseId') is null
      order by idx desc limit 1`;
    return rows[0] && (JSON.parse(rows[0].payload) as { text: string }).text;
  });
