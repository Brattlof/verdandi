import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import {
  type CommandId,
  GatewayUnavailable,
  type GatewayView,
  type InboundMessage,
  normalizeCode,
  type PendingPairing,
  type PlatformAdapter,
  pairingAlphabet,
  pairingCodeLength,
} from "@verdandi/contracts";
import { Context, Effect, FiberSet, Layer, PubSub, Schedule, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Engine } from "../event-store/engine.ts";
import { type Access, access, defaultAccess, pairingLimits } from "./access.ts";
import type { GatewayConfig } from "./gateway-config.ts";
import { loadAccessState, loadGatewayView, loadPending } from "./gateway-store.ts";

/** The chat apps an always-on verdandid connects, with `gateway.yaml`'s rules for them. */
export type GatewaySetup = { readonly config: GatewayConfig; readonly adapters: readonly PlatformAdapter[] };

/** The salted SHA-256 of a pairing code, hex: all that's kept of it. */
export const hashCode = (salt: string, code: string) => createHash("sha256").update(salt).update(normalizeCode(code)).digest("hex");

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

const makeCode = () => Array.from({ length: pairingCodeLength }, () => pairingAlphabet[randomInt(pairingAlphabet.length)]).join("");

const gatewayEvents = new Set(["pairing.requested", "pairing.approved", "pairing.denied", "sender.revoked", "gateway.owner.changed"]);

/**
 * The messaging gateway (DESIGN §15). Every verdandid can list senders and answer pairing requests; only an always-on one
 * (`setup`) connects chat apps and reads their messages, each through the access module (`access.ts`).
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

export const GatewayLive = (setup: GatewaySetup | undefined) =>
  Layer.effect(
    Gateway,
    Effect.gen(function* () {
      const engine = yield* Engine;
      const sql = yield* SqlClient.SqlClient;
      const withSql = Effect.provideService(SqlClient.SqlClient, sql);
      const adapters = new Map((setup?.adapters ?? []).map((a) => [a.platform, a]));
      const sends = yield* FiberSet.make();
      const changed = yield* PubSub.unbounded<void>();
      // Read as of each call: a pairing request drops out of it once its hour runs out.
      const view = Effect.suspend(() => loadGatewayView(new Date(), [...adapters.keys()])).pipe(withSql, Effect.orDie);

      /** Sends without holding up the caller; a failure is logged. */
      const tell = (adapter: PlatformAdapter | undefined, chatId: string, text: string) =>
        adapter
          ? FiberSet.run(
              sends,
              adapter
                .send(chatId, text)
                .pipe(Effect.ignoreCause({ log: "Warn", message: `Could not send a message to ${adapter.platform} chat ${chatId}.` })),
            ).pipe(Effect.asVoid)
          : Effect.void;

      yield* engine.react(({ event }) =>
        !gatewayEvents.has(event.type)
          ? Effect.void
          : Effect.andThen(
              PubSub.publish(changed, undefined),
              event.type === "pairing.approved"
                ? tell(adapters.get(event.platform), event.chatId, "The owner let you in: what you send here now reaches Verdandi.")
                : Effect.void,
            ),
      );

      const pairSender = (adapter: PlatformAdapter, m: InboundMessage, now: Date) =>
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
          yield* tell(
            adapter,
            m.chatId,
            `Verdandi doesn't know you yet, so this message wasn't read. Your pairing code is ${code}; it works for an hour. Send it to Verdandi's owner, who lets you in with: verdandi gateway pair ${code}`,
          );
        });

      const outcomes: {
        readonly [K in Access["kind"]]: (
          a: Extract<Access, { kind: K }>,
          adapter: PlatformAdapter,
          m: InboundMessage,
          now: Date,
        ) => Effect.Effect<void, unknown>;
      } = {
        ignore: (a, _, m) => Effect.logDebug(`Ignored a ${m.platform} message: ${a.reason}.`),
        pair: (_, adapter, m, now) => pairSender(adapter, m, now),
        refuse: (a, adapter, m) => tell(adapter, m.chatId, a.reply),
        // ponytail: allowed messages stop here until chats are bound to threads; the binding and outbox (DESIGN §15) run them.
        command: (_, __, m) => Effect.logDebug(`A ${m.platform} command waits for chats bound to threads.`),
        turn: (_, __, m) => Effect.logDebug(`A ${m.platform} message waits for chats bound to threads.`),
      };

      const receive = (adapter: PlatformAdapter, m: InboundMessage) =>
        Effect.gen(function* () {
          const now = new Date();
          const state = yield* loadAccessState(m.platform, m.sender.id, now).pipe(withSql);
          const decided = access(setup?.config[m.platform] ?? defaultAccess, state, m, now);
          yield* (
            outcomes[decided.kind] as (a: Access, adapter: PlatformAdapter, m: InboundMessage, now: Date) => Effect.Effect<void, unknown>
          )(decided, adapter, m, now);
        }).pipe(Effect.ignoreCause({ log: "Warn", message: `Could not handle a ${m.platform} message.` }));

      // Each chat app's messages, one at a time, so a pairing request counts before the next message is checked.
      for (const adapter of adapters.values()) {
        yield* Effect.forkScoped(
          adapter.messages.pipe(
            Stream.runForEach((m) => receive(adapter, m)),
            Effect.ignoreCause({ log: "Warn", message: `Lost ${adapter.platform}; reconnecting in 5 seconds.` }),
            Effect.repeat(Schedule.spaced("5 seconds")),
          ),
        );
      }

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
