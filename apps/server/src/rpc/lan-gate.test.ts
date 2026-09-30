import { afterEach, expect, test } from "bun:test";
import type { CommandId, ThreadId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { connect } from "./client.ts";
import { hostProblem, isLocalAddress, startLanGate } from "./lan-gate.ts";
import { ServerInfo, ServerLayer } from "./server.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

test("only loopback and private addresses count as the local network", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.8",
    "172.16.0.1",
    "172.31.255.1",
    "192.168.1.20",
    "169.254.3.4",
    "::1",
    "fd12::1",
    "fe80::1",
    "::ffff:192.168.1.20",
  ])
    expect([ip, isLocalAddress(ip)]).toEqual([ip, true]);
  for (const ip of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "100.64.0.1", "2001:db8::1", "::ffff:8.8.8.8", "localhost", ""])
    expect([ip, isLocalAddress(ip)]).toEqual([ip, false]);
});

test("--host takes every interface or a local address, and refuses a public one naming the fix", () => {
  expect(hostProblem("0.0.0.0")).toBeUndefined();
  expect(hostProblem("::")).toBeUndefined();
  expect(hostProblem("192.168.1.20")).toBeUndefined();
  expect(hostProblem("203.0.113.9")).toContain("is a public address");
  expect(hostProblem("my-pc")).toContain("takes an IP address");
});

const startServer = async () => {
  const home = makeTempHome();
  const runtime = ManagedRuntime.make(ServerLayer(home, { fake: makeFakeHarness() }));
  cleanups.push(() => removeTempHome(home));
  cleanups.push(() => runtime.dispose());
  const info = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ServerInfo;
    }),
  );
  return { ...info, home };
};

test("the gate relays the web UI, the RPC WebSocket and attachments to verdandid on loopback", async () => {
  const info = await startServer();
  const gate = startLanGate("127.0.0.1", 0, info.port);
  cleanups.push(() => gate.stop(true));
  const page = await fetch(`http://127.0.0.1:${gate.port}/`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('<div id="root">');
  const harnesses = await Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(connect({ port: gate.port ?? 0, token: info.token }), (c) =>
        Effect.andThen(
          c.CommandDispatch({
            type: "thread.create",
            commandId: crypto.randomUUID() as CommandId,
            threadId: crypto.randomUUID() as ThreadId,
            projectPath: info.home,
          }),
          c.HarnessesList(),
        ),
      ),
    ),
  );
  expect(harnesses).toEqual(["fake"]);
  const unauthorized = await fetch(`http://127.0.0.1:${gate.port}/attachments/${"a".repeat(64)}.png`);
  expect(unauthorized.status).toBe(401); // verdandid's own answer, relayed
});

test("the gate refuses every request from outside the local network, the web UI's files included", async () => {
  const info = await startServer();
  const gate = startLanGate("127.0.0.1", 0, info.port, () => false);
  cleanups.push(() => gate.stop(true));
  for (const path of ["/", "/rpc", "/attachments/x"]) {
    const answer = await fetch(`http://127.0.0.1:${gate.port}${path}`);
    expect([path, answer.status]).toEqual([path, 403]);
  }
  const refused = await Effect.runPromise(
    Effect.exit(
      Effect.scoped(Effect.flatMap(connect({ port: gate.port ?? 0, token: info.token }), (c) => c.HarnessesList())).pipe(
        Effect.timeout("3 seconds"),
      ),
    ),
  );
  expect(refused._tag).toBe("Failure");
});
