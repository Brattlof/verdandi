import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  type CommandId,
  type DeviceId,
  DevicesUnavailable,
  type DevicesView,
  type DeviceView,
  deviceName,
  maxPendingPairings,
  type PairingRequest,
  type PairMessage,
} from "@verdandi/contracts";
import { Context, Deferred, Effect, Layer, PubSub, type Scope, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Engine } from "../event-store/engine.ts";

/** The SHA-256 of a device token, as `device.paired` keeps it. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

type Pending = { readonly request: PairingRequest; readonly outcome: Deferred.Deferred<PairMessage> };

/**
 * Paired devices (ADR 0028). Pairing requests wait in memory, never in the log, so a client that hasn't paired can't
 * write events; a restart drops them, and the device asks again. Approving one makes the device's token here, records
 * only its hash (`device.pair`), and hands the token to the request's own socket.
 */
export class Devices extends Context.Service<
  Devices,
  {
    /** Raises a pairing request, or says why not: at most `maxPendingPairings` wait. Withdraw it when its socket closes. */
    readonly request: (from: { readonly address: string; readonly userAgent: string }) => Effect.Effect<Pending | string>;
    readonly withdraw: (requestId: string) => Effect.Effect<void>;
    /** Refuses every waiting request, so their sockets close: verdandid is stopping, and Bun's server waits for open sockets. */
    readonly refuseAll: Effect.Effect<void>;
    readonly approve: (requestId: string) => Effect.Effect<DeviceView, DevicesUnavailable>;
    readonly deny: (requestId: string) => Effect.Effect<void, DevicesUnavailable>;
    /** The device a token belongs to, unless it's revoked, noting that it was seen now. */
    readonly authenticate: (token: string) => Effect.Effect<DeviceId | undefined>;
    /** Resolves when the device is revoked, so its open connections close; scoped to the connection. */
    readonly revoked: (deviceId: DeviceId) => Effect.Effect<Deferred.Deferred<void>, never, Scope.Scope>;
    readonly view: Effect.Effect<DevicesView>;
    /** The view, then again whenever a device or a pairing request comes or goes. */
    readonly feed: Stream.Stream<DevicesView>;
  }
>()("verdandi/Devices") {}

const notFound = (requestId: string) =>
  new DevicesUnavailable({
    reason: "RequestNotFound",
    message: `No pairing request ${requestId} is waiting: it was answered, withdrawn when its device left, or verdandid restarted. verdandi devices list shows the waiting ones.`,
  });

export const DevicesLive = Layer.effect(
  Devices,
  Effect.gen(function* () {
    const engine = yield* Engine;
    const sql = yield* SqlClient.SqlClient;
    const pending = new Map<string, Pending>();
    const sockets = new Map<DeviceId, Set<Deferred.Deferred<void>>>();
    const changed = yield* PubSub.unbounded<void>();
    const signal = PubSub.publish(changed, undefined);

    yield* engine.react((stored) =>
      stored.event.type === "device.paired"
        ? signal
        : stored.event.type === "device.revoked"
          ? Effect.forEach(sockets.get(stored.event.deviceId) ?? [], (d) => Deferred.succeed(d, undefined), { discard: true }).pipe(
              Effect.andThen(signal),
            )
          : Effect.void,
    );

    const devices = sql<{ deviceId: DeviceId; name: string; pairedAt: string; lastSeen: string | null; revoked: number }>`
      select d.id as deviceId, d.name, d.paired_at as pairedAt, s.seen_at as lastSeen, d.revoked_at is not null as revoked
      from devices d left join device_seen s on s.id = d.id order by d.paired_at`.pipe(
      Effect.map((rows) => rows.map((r): DeviceView => ({ ...r, revoked: r.revoked === 1 }))),
      Effect.orDie,
    );
    const view = Effect.map(devices, (list) => ({ devices: list, pending: [...pending.values()].map((p) => p.request) }));

    const take = (requestId: string) =>
      Effect.suspend(() => {
        const p = pending.get(requestId);
        if (!p) return Effect.fail(notFound(requestId));
        pending.delete(requestId);
        return Effect.as(signal, p);
      });

    return Devices.of({
      request: ({ address, userAgent }) =>
        Effect.gen(function* () {
          if (pending.size >= maxPendingPairings)
            return `${maxPendingPairings} pairing requests already wait. Ask the owner to approve or deny one, then try again.`;
          const request: PairingRequest = {
            requestId: randomUUID(),
            code: randomInt(0, 1_000_000).toString().padStart(6, "0"),
            name: deviceName(userAgent),
            address,
            userAgent: userAgent.slice(0, 300),
            at: new Date().toISOString(),
          };
          const p = { request, outcome: yield* Deferred.make<PairMessage>() };
          pending.set(request.requestId, p);
          yield* signal;
          return p;
        }),
      withdraw: (requestId) => (pending.delete(requestId) ? signal : Effect.void),
      refuseAll: Effect.forEach(
        [...pending.keys()],
        (requestId) =>
          Effect.flatMap(take(requestId), ({ outcome }) =>
            Deferred.succeed(outcome, { kind: "refused", message: "verdandid stopped. Ask again once it runs." }),
          ).pipe(Effect.ignore),
        { discard: true },
      ),
      approve: (requestId) =>
        Effect.gen(function* () {
          const { request, outcome } = yield* take(requestId);
          const token = randomBytes(32).toString("hex");
          const deviceId = randomUUID() as DeviceId;
          yield* engine
            .dispatch({
              type: "device.pair",
              commandId: randomUUID() as CommandId,
              deviceId,
              name: request.name,
              tokenHash: hashToken(token),
            })
            .pipe(Effect.orDie);
          yield* Deferred.succeed(outcome, { kind: "approved", deviceId, token });
          const paired = (yield* devices).find((d) => d.deviceId === deviceId);
          return paired ?? { deviceId, name: request.name, pairedAt: new Date().toISOString(), lastSeen: null, revoked: false };
        }),
      deny: (requestId) =>
        Effect.flatMap(take(requestId), ({ outcome }) =>
          Deferred.succeed(outcome, { kind: "refused", message: "The owner denied this device's pairing request." }),
        ),
      authenticate: (token) =>
        Effect.gen(function* () {
          const [row] = yield* sql<{ id: DeviceId }>`
            select id from devices where token_hash = ${hashToken(token)} and revoked_at is null`;
          if (!row) return undefined;
          yield* sql`insert or replace into device_seen (id, seen_at) values (${row.id}, ${new Date().toISOString()})`;
          return row.id;
        }).pipe(Effect.orDie),
      revoked: (deviceId) =>
        Effect.acquireRelease(
          Effect.map(Deferred.make<void>(), (d) => {
            const set = sockets.get(deviceId) ?? new Set();
            sockets.set(deviceId, set.add(d));
            return d;
          }),
          (d) => Effect.sync(() => sockets.get(deviceId)?.delete(d)),
        ),
      view,
      feed: Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading, so a change in between isn't lost; each change sends the whole view again.
          const subscription = yield* PubSub.subscribe(changed);
          return Stream.concat(Stream.fromEffect(view), Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => view)));
        }),
      ),
    });
  }),
);
