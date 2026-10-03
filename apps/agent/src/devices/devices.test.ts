import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import type { CommandId, DeviceId, PairMessage } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Deferred, Effect, Fiber, ManagedRuntime, type Scope, Stream } from "effect";
import { connect } from "../rpc/client.ts";
import { ServerInfo, ServerLayer } from "../rpc/server.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const start = async (home: string) => {
  const runtime = ManagedRuntime.make(ServerLayer(home, { fake: makeFakeHarness() }));
  const info = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ServerInfo;
    }),
  );
  return { info, stop: () => runtime.dispose() };
};

/** Runs `f` with a client holding `token`, closing it after. */
const withClient = <A, E>(
  port: number,
  token: string,
  f: (client: Effect.Success<ReturnType<typeof connect>>) => Effect.Effect<A, E, Scope.Scope>,
) => Effect.runPromise(Effect.scoped(Effect.flatMap(connect({ port, token }), f)));

/** A pairing socket at `url`, and the next message it sends. */
const openPairing = (url: string, headers: Record<string, string> = {}) => {
  const socket = new WebSocket(url, { headers } as never);
  const queue: PairMessage[] = [];
  const waiting: ((m: PairMessage) => void)[] = [];
  socket.onmessage = (e) => {
    const message = JSON.parse(String(e.data)) as PairMessage;
    const next = waiting.shift();
    if (next) next(message);
    else queue.push(message);
  };
  const next = () => {
    const queued = queue.shift();
    return queued ? Promise.resolve(queued) : new Promise<PairMessage>((resolve) => waiting.push(resolve));
  };
  return { socket, next };
};

const auth = (port: number, token: string, scheme = "Device") =>
  fetch(`http://127.0.0.1:${port}/auth`, { headers: { authorization: `${scheme} ${token}` } }).then((r) => r.status);

test("a device pairs once the owner approves, its token survives a restart, revoking it closes its socket, and no token is logged", async () => {
  const home = makeTempHome();
  cleanups.push(() => removeTempHome(home));
  let server = await start(home);
  cleanups.push(() => server.stop());

  const pairing = openPairing(`ws://127.0.0.1:${server.info.port}/pair`, {
    "x-verdandi-client": "192.168.1.50",
    "user-agent": "Mozilla/5.0 (iPhone) Safari/604.1",
  });
  const pending = await pairing.next();
  if (pending.kind !== "pending") throw new Error(`expected a pending request, got ${pending.kind}`);
  const waiting = await withClient(server.info.port, server.info.token, (c) => c.DevicesList());
  expect(waiting.pending).toEqual([expect.objectContaining({ code: pending.code, address: "192.168.1.50", name: "Safari on iPhone" })]);

  const approved = withClient(server.info.port, server.info.token, (c) => c.DeviceApprove({ requestId: pending.requestId }));
  const issued = await pairing.next();
  if (issued.kind !== "approved") throw new Error(`expected approval, got ${issued.kind}`);
  expect((await approved).deviceId).toBe(issued.deviceId);
  const asDevice = (port: number) =>
    Effect.runPromise(Effect.scoped(Effect.flatMap(connect({ port, token: issued.token, device: true }), (c) => c.HarnessesList())));
  expect(await asDevice(server.info.port)).toContain("fake");
  // A device token is only ever a device's: as the profile's token it opens nothing.
  expect(await auth(server.info.port, issued.token, "Bearer")).toBe(401);

  await server.stop();
  server = await start(home);
  expect(await auth(server.info.port, issued.token)).toBe(200);

  const open = new WebSocket(`ws://127.0.0.1:${server.info.port}/rpc?device=${issued.token}`);
  await new Promise((resolve) => (open.onopen = resolve));
  const closed = new Promise((resolve) => (open.onclose = resolve));
  await withClient(server.info.port, server.info.token, (c) =>
    c.CommandDispatch({ type: "device.revoke", commandId: crypto.randomUUID() as CommandId, deviceId: issued.deviceId as DeviceId }),
  );
  await closed;
  expect(await auth(server.info.port, issued.token)).toBe(401);
  const listed = await withClient(server.info.port, server.info.token, (c) => c.DevicesList());
  expect(listed.devices).toEqual([expect.objectContaining({ deviceId: issued.deviceId, revoked: true, lastSeen: expect.any(String) })]);

  await server.stop();
  const db = new Database(join(home, "verdandi.db"), { readonly: true });
  const payloads = db.query<{ payload: string }, []>("select payload from events").all();
  db.close();
  expect(payloads.some((p) => p.payload.includes("device.paired"))).toBe(true);
  expect(payloads.some((p) => p.payload.includes(issued.token))).toBe(false);
});

test("a fourth pairing request is refused while three wait, and closing a request's socket withdraws it", async () => {
  const home = makeTempHome();
  cleanups.push(() => removeTempHome(home));
  const server = await start(home);
  cleanups.push(() => server.stop());
  const url = `ws://127.0.0.1:${server.info.port}/pair`;
  const first = openPairing(url);
  const three = [first, openPairing(url), openPairing(url)];
  for (const p of three) expect((await p.next()).kind).toBe("pending");
  const fourth = await openPairing(url).next();
  expect(fourth).toMatchObject({ kind: "refused", message: expect.stringContaining("3 pairing requests already wait") });

  const gone = new Promise((resolve) => (first.socket.onclose = resolve));
  first.socket.close();
  await gone;
  // The server sees the close on its own time; the feed says when the request is gone. Feeds end by Unsubscribe (ADR 0008).
  await withClient(server.info.port, server.info.token, (c) =>
    Effect.gen(function* () {
      const two = yield* Deferred.make<void>();
      const feed = yield* c.DevicesSubscribe({ subscriptionId: "s" }).pipe(
        Stream.runForEach((v) => (v.pending.length === 2 ? Deferred.succeed(two, undefined) : Effect.void)),
        Effect.forkScoped,
      );
      yield* Deferred.await(two);
      yield* c.Unsubscribe({ subscriptionId: "s" });
      yield* Fiber.join(feed);
    }),
  );
});
