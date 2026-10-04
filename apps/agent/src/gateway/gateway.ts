import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type ChannelBinding,
  type CommandId,
  type Event,
  GatewayUnavailable,
  type GatewayView,
  type InboundMessage,
  normalizeCode,
  type OutboundMessage,
  type PendingPairing,
  type PlatformAdapter,
  pairingAlphabet,
  pairingCodeLength,
  type TurnId,
} from "@verdandi/contracts";
import { Context, Effect, FiberSet, Layer, PubSub, Schedule, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Engine } from "../event-store/engine.ts";
import { type Access, access, defaultAccess, pairingLimits } from "./access.ts";
import type { GatewayConfig } from "./gateway-config.ts";
import { makeOutbox } from "./gateway-outbox.ts";
import { loadAccessState, loadGatewayView, loadPending } from "./gateway-store.ts";
import { makeConversations } from "./gateway-turns.ts";

/** The chat apps an always-on verdandid connects, with `gateway.yaml`'s rules for them. */
export type GatewaySetup = { readonly config: GatewayConfig; readonly adapters: readonly PlatformAdapter[] };

/** The salted SHA-256 of a pairing code, hex: all that's kept of it. */
export const hashCode = (salt: string, code: string) => createHash("sha256").update(salt).update(normalizeCode(code)).digest("hex");

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

const makeCode = () => Array.from({ length: pairingCodeLength }, () => pairingAlphabet[randomInt(pairingAlphabet.length)]).join("");

const gatewayEvents = new Set(["pairing.requested", "pairing.approved", "pairing.denied", "sender.revoked", "gateway.owner.changed"]);

/** A turn's progress line in its chat: one message, edited in place at most every 5 seconds, outside the outbox. */
type Progress = { readonly adapter: PlatformAdapter; readonly chatId: string; messageId?: string; steps: number; editedAt: number };
const progressEvery = 5_000;

/**
 * The messaging gateway (DESIGN §15). Every verdandid can list senders and answer pairing requests; only an always-on one
 * (`setup`) connects chat apps, reads their messages, each through the access module (`access.ts`), and sends what the
 * outbox holds.
 */
export class Gateway extends Context.Service<
  Gateway,
  {
    readonly view: Effect.Effect<GatewayView>;
    /** The view, then again whenever a pairing request or a sender's access changes. */
    readonly feed: Stream.Stream<GatewayView>;
    /** Approves the waiting request whose sender got `code`; `owner` also makes them the platform's owner. */
    readonly pair: (code: string, owner: boolean) => Effect.Effect<PendingPairing, GatewayUnavailable>;
  }
>()("verdandi/Gateway") {}

export const GatewayLive = (home: string, setup: GatewaySetup | undefined) =>
  Layer.effect(
    Gateway,
    Effect.gen(function* () {
      const engine = yield* Engine;
      const sql = yield* SqlClient.SqlClient;
      const withSql = Effect.provideService(SqlClient.SqlClient, sql);
      const adapters = new Map((setup?.adapters ?? []).map((a) => [a.platform, a]));
      const fibers = yield* FiberSet.make();
      const changed = yield* PubSub.unbounded<void>();
      // Read as of each call: a pairing request drops out of it once its hour runs out.
      const view = Effect.suspend(() => loadGatewayView(new Date(), [...adapters.keys()])).pipe(withSql, Effect.orDie);
      const outbox = makeOutbox(engine, sql, adapters, fibers);
      const conversations = makeConversations(home, engine, sql);

      /** Runs in the background, so a reaction or the next message never waits on a chat app; a failure is logged. */
      const background = (what: string, effect: Effect.Effect<unknown, unknown>) =>
        FiberSet.run(fibers, effect.pipe(Effect.ignoreCause({ log: "Warn", message: `The gateway couldn't ${what}.` }))).pipe(
          Effect.asVoid,
        );
      const tell = (adapter: PlatformAdapter | undefined, message: OutboundMessage) =>
        adapter ? background(`send a message to ${adapter.platform} chat ${message.chatId}`, adapter.send(message)) : Effect.void;
      const replyTo = (m: InboundMessage, text: string | undefined) =>
        text
          ? tell(adapters.get(m.platform), {
              chatId: m.chatId,
              ...(m.platformThread !== undefined && { platformThread: m.platformThread }),
              text,
            })
          : Effect.void;

      const progress = new Map<TurnId, Progress>();
      const edit = (p: Progress, text: string) =>
        p.messageId ? background("update a progress message", p.adapter.edit(p.chatId, p.messageId, text)) : Effect.void;
      const track = (event: Event) =>
        Effect.gen(function* () {
          if (event.type === "turn.started") {
            const [row] = yield* sql<{ binding: string }>`select binding from channel_bindings where thread_id = ${event.threadId}`;
            const binding = row && (JSON.parse(row.binding) as ChannelBinding);
            const adapter = binding && adapters.get(binding.platform);
            if (!binding || !adapter) return;
            const p: Progress = { adapter, chatId: binding.chatId, steps: 0, editedAt: Date.now() };
            progress.set(event.turnId, p);
            const started = { chatId: binding.chatId, ...(binding.platformThread !== null && { platformThread: binding.platformThread }) };
            yield* background(
              "send a progress message",
              adapter
                .send({ ...started, text: "Working on it…" })
                .pipe(Effect.tap(({ messageId }) => Effect.sync(() => (p.messageId = messageId)))),
            );
          } else if (event.type === "turn.item.added" && event.item.kind === "tool.call") {
            const p = progress.get(event.turnId);
            if (!p) return;
            p.steps++;
            if (Date.now() - p.editedAt < progressEvery) return;
            p.editedAt = Date.now();
            yield* edit(p, `Working on it… ${p.steps} step${p.steps === 1 ? "" : "s"} so far.`);
          } else if (event.type === "turn.completed") {
            const p = progress.get(event.turnId);
            if (!p) return;
            progress.delete(event.turnId);
            yield* edit(p, `Finished (${event.status}) after ${p.steps} step${p.steps === 1 ? "" : "s"}.`);
          }
        }).pipe(Effect.catchTag("SqlError", Effect.die));

      yield* engine.react(({ event }) =>
        Effect.gen(function* () {
          if (gatewayEvents.has(event.type)) yield* PubSub.publish(changed, undefined);
          if (event.type === "pairing.approved")
            yield* tell(adapters.get(event.platform), {
              chatId: event.chatId,
              text: "The owner let you in: what you send here now reaches Verdandi.",
            });
          if (event.type === "delivery.requested") yield* outbox.start(event.deliveryId);
          if (adapters.size > 0) yield* track(event);
        }),
      );

      const pairSender = (m: InboundMessage, now: Date) =>
        Effect.gen(function* () {
          const code = makeCode();
          const salt = randomBytes(16).toString("hex");
          yield* engine.dispatch({
            type: "pairing.request",
            commandId: randomUUID() as CommandId,
            requestId: randomUUID(),
            platform: m.platform,
            chatId: m.chatId,
            senderId: m.sender.id,
            senderName: m.sender.name,
            codeHash: hashCode(salt, code),
            salt,
            expiresAt: new Date(now.getTime() + pairingLimits.lifetimeMs).toISOString(),
          });
          // The code goes to this DM only: the log keeps its salted hash.
          yield* replyTo(
            m,
            `Verdandi doesn't know you yet, so this message wasn't read. Your pairing code is ${code}; it works for an hour. Send it to Verdandi's owner, who lets you in with: verdandi gateway pair ${code}`,
          );
        });

      const outcomes: {
        readonly [K in Access["kind"]]: (a: Extract<Access, { kind: K }>, m: InboundMessage, now: Date) => Effect.Effect<void, unknown>;
      } = {
        ignore: (a, m) => Effect.logDebug(`Ignored a ${m.platform} message: ${a.reason}.`),
        pair: (_, m, now) => pairSender(m, now),
        refuse: (a, m) => replyTo(m, a.reply),
        command: (a, m) => Effect.flatMap(conversations.command(m, a).pipe(withSql), (text) => replyTo(m, text)),
        turn: (a, m) => Effect.flatMap(conversations.turn(m, a), (refused) => replyTo(m, refused)),
      };

      const receive = (m: InboundMessage) =>
        Effect.gen(function* () {
          const now = new Date();
          const state = yield* loadAccessState(m.platform, m.sender.id, now).pipe(withSql);
          const decided = access(setup?.config[m.platform] ?? defaultAccess, state, m, now);
          yield* (outcomes[decided.kind] as (a: Access, m: InboundMessage, now: Date) => Effect.Effect<void, unknown>)(decided, m, now);
        }).pipe(Effect.ignoreCause({ log: "Warn", message: `Could not handle a ${m.platform} message.` }));

      // Each chat app's messages, one at a time, so a pairing request counts before the next message is checked.
      for (const adapter of adapters.values()) {
        yield* Effect.forkScoped(
          adapter.messages.pipe(
            Stream.runForEach(receive),
            Effect.ignoreCause({ log: "Warn", message: `Lost ${adapter.platform}; reconnecting in 5 seconds.` }),
            Effect.repeat(Schedule.spaced("5 seconds")),
          ),
        );
      }
      // What a stopped verdandid left in the outbox goes out now, marked when it may be a repeat.
      if (adapters.size > 0) yield* outbox.resume.pipe(Effect.catchTag("SqlError", Effect.die));

      return Gateway.of({
        view,
        feed: Stream.unwrap(
          Effect.map(PubSub.subscribe(changed), (subscription) =>
            // Subscribed before the first read, so a change in between isn't lost.
            Stream.concat(Stream.fromEffect(view), Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => view))),
          ),
        ),
        pair: (code, owner) =>
          Effect.gen(function* () {
            const pending = yield* loadPending(new Date()).pipe(withSql, Effect.catchTag("SqlError", Effect.die));
            const match = pending.find((p) => sameHash(hashCode(p.salt, code), p.codeHash));
            if (!match)
              return yield* new GatewayUnavailable({
                reason: "PairingNotFound",
                message:
                  "No pairing request waits with that code: it was mistyped, already answered, or its hour ran out and the sender has to ask again. verdandi gateway senders lists the waiting ones.",
              });
            yield* engine
              .dispatch({ type: "pairing.approve", commandId: randomUUID() as CommandId, requestId: match.requestId, owner })
              .pipe(
                Effect.catchTag("CommandRejected", (e) =>
                  Effect.fail(new GatewayUnavailable({ reason: "PairingNotFound", message: e.message })),
                ),
                Effect.catchTag("SqlError", Effect.die),
              );
            const { requestId, platform, senderId, senderName, at, expiresAt } = match;
            return { requestId, platform, senderId, senderName, at, expiresAt };
          }),
      });
    }),
  );
