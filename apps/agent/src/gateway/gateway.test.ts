import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandId } from "@verdandi/contracts";
import { makeFakeChannel, makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime, type Scope } from "effect";
import { Engine } from "../event-store/engine.ts";
import { connect } from "../rpc/client.ts";
import { ServerInfo, ServerLayer } from "../rpc/server.ts";
import { defaultAccess } from "./access.ts";
import { hashCode } from "./gateway.ts";
import { gatewaySettingsFile, loadGatewayConfig } from "./gateway-config.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const start = async (home: string, channel: ReturnType<typeof makeFakeChannel>) => {
  const runtime = ManagedRuntime.make(
    ServerLayer(home, { fake: makeFakeHarness() }, { gateway: { config: { fake: defaultAccess }, adapters: [channel.adapter] } }),
  );
  const info = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ServerInfo;
    }),
  );
  const call = <A, E>(f: (client: Effect.Success<ReturnType<typeof connect>>) => Effect.Effect<A, E, Scope.Scope>) =>
    Effect.runPromise(Effect.scoped(Effect.flatMap(connect(info), f)));
  return { call, runtime, stop: () => runtime.dispose() };
};

const codeIn = (text: string) => /pairing code is ([A-Z2-9]{8})/.exec(text)?.[1] ?? "";

test("an unknown sender pairs by request id, and the database keeps only the code's salted hash", async () => {
  const home = makeTempHome();
  cleanups.push(() => removeTempHome(home));
  const channel = makeFakeChannel();
  const server = await start(home, channel);
  cleanups.push(() => server.stop());

  channel.receive({ id: "9", name: "Stranger" }, "hello?");
  const offer = await channel.next();
  const code = codeIn(offer.text);
  expect(offer.chatId).toBe("9");
  expect(code).toHaveLength(8);

  // Asking again within 10 minutes gets nothing; messages are handled in order, so the next sender's reply means it was read.
  channel.receive({ id: "9", name: "Stranger" }, "hello again?");
  channel.receive({ id: "8", name: "Other" }, "hi");
  expect((await channel.next()).chatId).toBe("8");

  const waiting = await server.call((c) => c.GatewayList());
  const request = waiting.pending.find((p) => p.senderId === "9");
  expect(request).toMatchObject({ platform: "fake", senderName: "Stranger" });
  await server.call((c) =>
    c.CommandDispatch({
      type: "pairing.approve",
      commandId: crypto.randomUUID() as CommandId,
      requestId: request?.requestId ?? "",
      owner: false,
    }),
  );
  expect(await channel.next()).toMatchObject({ chatId: "9", text: expect.stringContaining("let you in") });
  const after = await server.call((c) => c.GatewayList());
  expect(after.senders).toEqual([{ platform: "fake", senderId: "9", name: "Stranger", pairedAt: expect.any(String), owner: false }]);
  expect(after.pending.map((p) => p.senderId)).toEqual(["8"]);
  expect(after.running).toEqual(["fake"]);

  await server.stop();
  const files = ["verdandi.db", "verdandi.db-wal"].map((f) => join(home, f)).filter(existsSync);
  expect(files.some((f) => readFileSync(f).includes(code))).toBe(false);
  const db = new Database(join(home, "verdandi.db"), { readonly: true });
  const row = db
    .query<{ salt: string; hash: string }, []>("select salt, code_hash as hash from gateway_pairings where sender_id = '9'")
    .get();
  db.close();
  expect(row?.hash).toBe(hashCode(row?.salt ?? "", code));
});

test("the owner approves a code from the CLI as the owner, and revoking the owner takes both away", async () => {
  const home = makeTempHome();
  cleanups.push(() => removeTempHome(home));
  const channel = makeFakeChannel();
  const server = await start(home, channel);
  cleanups.push(() => server.stop());

  channel.receive({ id: "1", name: "Me" }, "hi");
  const code = codeIn((await channel.next()).text);
  // A mistyped code approves nothing and says why.
  const wrong = await server.call((c) => c.GatewayPair({ code: "AAAAAAAA", owner: true }).pipe(Effect.flip));
  expect(wrong.message).toContain("No pairing request waits with that code");
  // Typed with a space and in lower case, it's the same code.
  const paired = await server.call((c) => c.GatewayPair({ code: `${code.slice(0, 4).toLowerCase()} ${code.slice(4)}`, owner: true }));
  expect(paired.senderId).toBe("1");
  await channel.next();
  expect((await server.call((c) => c.GatewayList())).senders).toEqual([expect.objectContaining({ senderId: "1", owner: true })]);

  await server.call((c) =>
    c.CommandDispatch({ type: "sender.revoke", commandId: crypto.randomUUID() as CommandId, platform: "fake", senderId: "1" }),
  );
  expect((await server.call((c) => c.GatewayList())).senders).toEqual([]);
  const again = await server.call((c) =>
    c
      .CommandDispatch({ type: "sender.revoke", commandId: crypto.randomUUID() as CommandId, platform: "fake", senderId: "1" })
      .pipe(Effect.flip),
  );
  expect(again.message).toContain("isn't paired or the owner");
});

test("a pairing request whose hour ran out is no longer listed and can't be approved", async () => {
  const home = makeTempHome();
  cleanups.push(() => removeTempHome(home));
  const channel = makeFakeChannel();
  const server = await start(home, channel);
  cleanups.push(() => server.stop());
  const salt = "00";
  const requestId = crypto.randomUUID();
  await server.runtime.runPromise(
    Effect.flatMap(Engine, (engine) =>
      engine.dispatch({
        type: "pairing.request",
        commandId: crypto.randomUUID() as CommandId,
        requestId,
        platform: "fake",
        chatId: "9",
        senderId: "9",
        senderName: "Late",
        codeHash: hashCode(salt, "ABCDEFGH"),
        salt,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ),
  );
  expect((await server.call((c) => c.GatewayList())).pending).toEqual([]);
  const late = await server.call((c) => c.GatewayPair({ code: "ABCDEFGH", owner: false }).pipe(Effect.flip));
  expect(late.reason).toBe("PairingNotFound");
  const byId = await server.call((c) =>
    c.CommandDispatch({ type: "pairing.approve", commandId: crypto.randomUUID() as CommandId, requestId, owner: false }).pipe(Effect.flip),
  );
  expect(byId.message).toContain("its hour ran out");
});

test("approving a sender answers every request they left waiting", async () => {
  const home = makeTempHome();
  cleanups.push(() => removeTempHome(home));
  const channel = makeFakeChannel();
  const server = await start(home, channel);
  cleanups.push(() => server.stop());
  const ask = (requestId: string) =>
    server.runtime.runPromise(
      Effect.flatMap(Engine, (engine) =>
        engine.dispatch({
          type: "pairing.request",
          commandId: crypto.randomUUID() as CommandId,
          requestId,
          platform: "fake",
          chatId: "9",
          senderId: "9",
          senderName: "Twice",
          codeHash: hashCode("00", requestId),
          salt: "00",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    );
  await ask("first");
  await ask("second");
  expect((await server.call((c) => c.GatewayList())).pending).toHaveLength(2);
  await server.call((c) =>
    c.CommandDispatch({ type: "pairing.approve", commandId: crypto.randomUUID() as CommandId, requestId: "second", owner: false }),
  );
  expect((await server.call((c) => c.GatewayList())).pending).toEqual([]);
});

test("a broken gateway.yaml fails naming the file and key", () => {
  const home = makeTempHome();
  cleanups.push(() => removeTempHome(home));
  writeFileSync(gatewaySettingsFile(home), "telegram:\n  dm: open\n");
  expect(() => loadGatewayConfig(home)).toThrow(/gateway\.yaml[\s\S]*dm/);
  writeFileSync(gatewaySettingsFile(home), 'telegram:\n  allowFrom: [123]\n  groups:\n    "-100": { senders: [123] }\n');
  expect(loadGatewayConfig(home)).toEqual({ telegram: { dm: "pairing", allowFrom: ["123"], groups: { "-100": { senders: ["123"] } } } });
});
