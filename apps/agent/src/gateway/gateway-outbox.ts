import { randomUUID } from "node:crypto";
import {
  type Button,
  type ChannelBinding,
  type CommandId,
  deliveryLimits,
  type Platform,
  type PlatformAdapter,
  type ThreadId,
} from "@verdandi/contracts";
import { Duration, Effect, FiberSet } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { Engine } from "../event-store/engine.ts";
import type { DeliveryState } from "./outbox.ts";

/** What a resent delivery starts with: an earlier try may have reached the chat, in whole or in part. */
export const possibleRepeat = "(Possibly a repeat: an earlier try to send this may have reached you.)";

/** How long a failed delivery waits before its next attempt: 30 seconds, then a minute, doubling. */
const backoff = (attempt: number) => Duration.seconds(30 * 2 ** (attempt - 1));

/**
 * The outbox's sending half (DESIGN §15): each delivery is attempted (`delivery.attempted`), sent, then reported, so a
 * crash in between is seen at the next start and the delivery sent again, marked as a possible repeat. A failure waits
 * and tries again, up to `deliveryLimits`; a chat that's gone isn't retried. A delivery for a chat app this verdandid
 * doesn't run waits until one that does starts.
 */
export const makeOutbox = (
  engine: Engine["Service"],
  sql: SqlClient.SqlClient,
  adapters: ReadonlyMap<Platform, PlatformAdapter>,
  fibers: FiberSet.FiberSet,
) => {
  const step = (type: "delivery.attempt", threadId: ThreadId, deliveryId: string) =>
    engine.dispatch({ type, commandId: randomUUID() as CommandId, threadId, deliveryId });
  const abandon = (threadId: ThreadId, deliveryId: string, reason: string) =>
    engine.dispatch({ type: "delivery.abandon", commandId: randomUUID() as CommandId, threadId, deliveryId, reason });

  const deliver = (deliveryId: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      const [row] = yield* sql<{
        threadId: ThreadId;
        binding: string;
        text: string;
        buttons: string;
        requestedAt: string;
        attempts: number;
        state: DeliveryState;
      }>`select thread_id as threadId, binding, text, buttons, requested_at as requestedAt, attempts, state
        from deliveries where id = ${deliveryId}`;
      if (!row || row.state === "sent" || row.state === "abandoned") return;
      const binding = JSON.parse(row.binding) as ChannelBinding;
      const adapter = adapters.get(binding.platform);
      if (!adapter) return;
      const { threadId } = row;
      if (row.attempts >= deliveryLimits.attempts || Date.now() - Date.parse(row.requestedAt) > deliveryLimits.withinMs)
        return yield* abandon(threadId, deliveryId, `gave up after ${row.attempts} attempts`);
      const receipt = yield* step("delivery.attempt", threadId, deliveryId);
      const [attempted] = yield* sql<{ attempt: number; duplicate: number }>`
        select json_extract(payload, '$.attempt') as attempt, json_extract(payload, '$.duplicate') as duplicate
        from events where command_id = ${receipt.commandId} and type = 'delivery.attempted'`;
      if (!attempted) return;
      const text = attempted.duplicate ? `${possibleRepeat}\n\n${row.text}` : row.text;
      const buttons = JSON.parse(row.buttons) as Button[];
      const sent = yield* adapter
        .send({
          chatId: binding.chatId,
          ...(binding.platformThread !== null && { platformThread: binding.platformThread }),
          text,
          ...(buttons.length > 0 && { buttons }),
        })
        .pipe(Effect.result);
      const report = { type: "delivery.report", commandId: randomUUID() as CommandId, threadId, deliveryId } as const;
      if (sent._tag === "Success") return yield* engine.dispatch({ ...report, outcome: "sent", messageId: sent.success.messageId });
      const error = sent.failure.message;
      yield* engine.dispatch({ ...report, outcome: "failed", error });
      if (sent.failure.gone) return yield* abandon(threadId, deliveryId, `the chat is gone (${error})`);
      yield* Effect.sleep(backoff(attempted.attempt));
      yield* deliver(deliveryId);
    });

  // One sender per delivery at a time, so a delivery committed while `resume` reads the outbox isn't sent twice.
  const sending = new Set<string>();
  /** Sends one delivery in the background; a failure that isn't the chat's is logged and retried by the next start. */
  const start = (deliveryId: string) =>
    Effect.suspend(() => {
      if (sending.has(deliveryId)) return Effect.void;
      sending.add(deliveryId);
      return FiberSet.run(
        fibers,
        deliver(deliveryId).pipe(
          Effect.ignoreCause({ log: "Warn", message: `The outbox couldn't deliver ${deliveryId}; the next start tries again.` }),
          Effect.ensuring(Effect.sync(() => sending.delete(deliveryId))),
        ),
      ).pipe(Effect.asVoid);
    });

  /** Picks up what a stopped verdandid left: deliveries never attempted, attempted but never reported, or failed. */
  const resume = Effect.gen(function* () {
    const open = yield* sql<{ id: string }>`
      select id from deliveries where state in ('requested', 'attempted', 'failed') order by requested_at`;
    yield* Effect.forEach(open, ({ id }) => start(id), { discard: true });
  });

  return { start, resume };
};
