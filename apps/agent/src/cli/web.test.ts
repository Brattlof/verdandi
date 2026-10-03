import { afterEach, expect, test } from "bun:test";
import type { CommandId, ThreadId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { startLanGate } from "@verdandi/web/lan-gate";
import { serveWeb } from "@verdandi/web/serve";
import { Effect, ManagedRuntime } from "effect";
import { connect } from "../rpc/client.ts";
import { ServerInfo, ServerLayer } from "../rpc/server.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** verdandid on the fake harness, and `verdandi web`'s server relaying to it. */
const startWeb = async () => {
  const home = makeTempHome();
  const runtime = ManagedRuntime.make(ServerLayer(home, { fake: makeFakeHarness() }));
  cleanups.push(() => removeTempHome(home));
  cleanups.push(() => runtime.dispose());
  const agent = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ServerInfo;
    }),
  );
  const ui = serveWeb(agent);
  cleanups.push(() => ui.stop());
  return { agent, ui, home };
};

const harnessesThrough = (port: number, token: string, home: string) =>
  Effect.runPromise(
    Effect.exit(
      Effect.scoped(
        Effect.flatMap(connect({ port, token }), (c) =>
          Effect.andThen(
            c.CommandDispatch({
              type: "thread.create",
              commandId: crypto.randomUUID() as CommandId,
              threadId: crypto.randomUUID() as ThreadId,
              projectPath: home,
            }),
            c.HarnessesList(),
          ),
        ),
      ).pipe(Effect.timeout("5 seconds")),
    ),
  );

test("the web server serves the UI's page and bundle, Tailwind compiled, without any token in them", async () => {
  const { agent, ui } = await startWeb();
  const page = await fetch(`http://127.0.0.1:${ui.port}/`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('<div id="root">');
  expect(html).not.toContain(ui.token);
  expect(html).not.toContain(agent.token);
  const script = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
  const bundle = await fetch(new URL(script ?? "", `http://127.0.0.1:${ui.port}/`));
  expect(bundle.status).toBe(200);
  expect(bundle.headers.get("content-type")).toContain("javascript");
  const stylesheet = html.match(/<link[^>]+href="([^"]+\.css)"/)?.[1];
  const css = await (await fetch(new URL(stylesheet ?? "", `http://127.0.0.1:${ui.port}/`))).text();
  expect(css).toContain(".bg-panel"); // packages/ui's classes, found by Tailwind
  expect(css).not.toContain("@tailwind"); // Tailwind ran, rather than Bun inlining its source
});

test("the page's token reaches the agent through the relay; the agent's own token doesn't get through the web server", async () => {
  const { agent, ui, home } = await startWeb();
  const through = await harnessesThrough(ui.port, ui.token, home);
  expect(through._tag === "Success" && through.value).toEqual(["fake"]);
  expect((await harnessesThrough(ui.port, agent.token, home))._tag).toBe("Failure");
  const attachment = `http://127.0.0.1:${ui.port}/attachments/${"a".repeat(64)}.png`;
  expect((await fetch(attachment)).status).toBe(401);
  // With the page's token the agent answers, so the swap worked: it has no such attachment.
  expect((await fetch(attachment, { headers: { authorization: `Bearer ${ui.token}` } })).status).toBe(404);
});

test("the web server refuses an upgrade from a page on another site even with the right token", async () => {
  const { ui } = await startWeb();
  const url = `ws://127.0.0.1:${ui.port}/rpc?token=${ui.token}`;
  const opens = (origin?: string) =>
    new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url, origin === undefined ? {} : { headers: { Origin: origin } });
      ws.onopen = () => {
        ws.close();
        resolve(true);
      };
      ws.onerror = () => resolve(false);
    });
  expect(await opens(`http://127.0.0.1:${ui.port}`)).toBe(true);
  expect(await opens(`http://localhost:${ui.port}`)).toBe(true);
  for (const foreign of ["https://evil.example", `http://evil.example:${ui.port}`, `http://localhost:${ui.port + 1}`, "null"])
    expect([foreign, await opens(foreign)]).toEqual([foreign, false]);
});

test("the gate relays the page and the RPC to the web server, and refuses a page it didn't serve", async () => {
  const { ui, home } = await startWeb();
  const gate = startLanGate("127.0.0.1", 0, ui.port);
  cleanups.push(() => gate.stop(true));
  expect(await (await fetch(`http://127.0.0.1:${gate.port}/`)).text()).toContain('<div id="root">');
  const through = await harnessesThrough(gate.port ?? 0, ui.token, home);
  expect(through._tag === "Success" && through.value).toEqual(["fake"]);
  const url = `ws://127.0.0.1:${gate.port}/rpc?token=${ui.token}`;
  const opens = (origin: string) =>
    new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url, { headers: { Origin: origin } });
      ws.onopen = () => {
        ws.close();
        resolve(true);
      };
      ws.onerror = () => resolve(false);
    });
  expect(await opens(`http://127.0.0.1:${gate.port}`)).toBe(true);
  // A hostname (DNS rebinding included), another port and another site are all refused.
  for (const foreign of [`http://localhost:${gate.port}`, `http://127.0.0.1:${ui.port}`, "https://evil.example"])
    expect([foreign, await opens(foreign)]).toEqual([foreign, false]);
});

test("the gate refuses every request from outside the local network, the page's files included", async () => {
  const { ui } = await startWeb();
  const gate = startLanGate("127.0.0.1", 0, ui.port, () => false);
  cleanups.push(() => gate.stop(true));
  for (const path of ["/", "/rpc", "/attachments/x"]) {
    const answer = await fetch(`http://127.0.0.1:${gate.port}${path}`);
    expect([path, answer.status]).toEqual([path, 403]);
  }
});
