import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, HarnessAdapter, ThreadId, TurnId } from "@verdandi/contracts";
import { makeNativeAdapter, type SecretStore } from "@verdandi/harness-native";
import { makeFakeChatCompletions, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { loadThreadView } from "../event-store/projector.ts";
import { Reactor } from "../event-store/reactor.ts";
import { catalogFor } from "../routing/routing.ts";
import { loadEndpoints, providersFile } from "./endpoints.ts";
import { nativeHarness } from "./native-harness.ts";

const homes: string[] = [];
const runtimes: ManagedRuntime.ManagedRuntime<unknown, unknown>[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const h of homes.splice(0)) removeTempHome(h);
});

const emptyKeychain: SecretStore = { get: async () => null, set: async () => {}, delete: async () => false };
const homeWith = (providers: string) => {
  const home = makeTempHome();
  homes.push(home);
  writeFileSync(providersFile(home), providers);
  return home;
};

const providers = `endpoints:
  ollama:
    url: http://127.0.0.1:11434/v1
    access: local
    models:
      qwen3:8b: { tier: S, context: 32768 }
  openrouter:
    url: https://openrouter.ai/api/v1
    access: metered
    models:
      qwen/qwen3-coder: { tier: M, context: 262144, efforts: [low, high], price: { input: 0.2, output: 0.8 } }
`;

test("configured endpoints' models join the catalog while their endpoint runs; a metered one needs its key", async () => {
  const home = homeWith(providers);
  const native = (adapter?: HarnessAdapter) =>
    catalogFor(adapter ? { native: adapter } : {})
      .filter((e) => e.harness === "native")
      .map((e) => `${e.provider} ${e.model} ${e.access}`);

  // No Anthropic key and no OpenRouter key: only the local endpoint runs, and the status line says why the rest don't.
  const local = await nativeHarness(home, [], {}, emptyKeychain);
  expect(native(local.adapter)).toEqual(["ollama qwen3:8b local"]);
  expect(local.status).toContain("ollama (local, 1 model)");
  expect(local.status).toContain("verdandi key set openrouter");
  expect(native()).toEqual([]);

  // With both keys, every provider's models join; the keys leave the environment and never reach the status line.
  const key = "or-" + "test-not-a-real-key";
  const env: Record<string, string | undefined> = { VERDANDI_OPENROUTER_API_KEY: key, VERDANDI_ANTHROPIC_API_KEY: "sk-ant-" + "test" };
  const all = await nativeHarness(home, [], env, emptyKeychain);
  expect(native(all.adapter)).toContain("openrouter qwen/qwen3-coder metered");
  expect(native(all.adapter)).toContain("anthropic claude-sonnet-5-5 metered");
  expect(all.status).not.toContain(key);
  expect(env).toEqual({});
  const coder = all.adapter?.catalog?.find((e) => e.model === "qwen/qwen3-coder");
  expect(coder).toMatchObject({
    tier: "M",
    efforts: ["low", "high"],
    vision: false,
    price: { input: 0.2, output: 0.8, cacheRead: 0.2, cacheWrite: 0.2 },
  });
});

test("a broken providers.yaml fails naming the file and the key", async () => {
  const failure = (text: string) =>
    loadEndpoints(homeWith(text), {}, emptyKeychain).then(
      () => "",
      (e: Error) => e.message,
    );
  const unpriced = await failure(providers.replace(", price: { input: 0.2, output: 0.8 }", ""));
  expect(unpriced).toContain("providers.yaml");
  expect(unpriced).toContain("endpoints.openrouter.models.qwen/qwen3-coder.price");
  expect(await failure(providers.replace("qwen3:8b", "claude-sonnet-5-5"))).toContain("endpoints.ollama.models.claude-sonnet-5-5");
  expect(await failure(providers.replace("http://127.0.0.1:11434/v1", "127.0.0.1:11434"))).toContain("endpoints.ollama.url");
  expect(await failure(providers.replace("access: local", "access: free"))).toContain("access");
  expect(await failure(`${providers}    keys: oops\n`)).toContain("keys");
});

test("verdandid runs a native turn on a local endpoint and records its usage as local, costing nothing", async () => {
  const home = makeTempHome();
  homes.push(home);
  const fake = makeFakeChatCompletions([
    { text: "Checking.", toolCalls: [{ id: "call_1", name: "glob", input: { pattern: "*.md" } }] },
    { text: "No Markdown files." },
  ]);
  const native = makeNativeAdapter({
    endpoints: [
      {
        id: "ollama",
        url: "http://127.0.0.1:11434/v1",
        key: undefined,
        models: [
          {
            harness: "native",
            provider: "ollama",
            model: "qwen3:8b",
            access: "local",
            tier: "S",
            context: 32768,
            vision: false,
            efforts: [],
            price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    ],
    sessionsDir: join(home, "native-sessions"),
    reach: { home, folders: [], readable: [] },
    terminal: { run: async () => ({ exitCode: 0, output: "", durationMs: 0 }), outputs: join(home, "terminal-output") },
    fetch: fake.fetch,
    cacheBreaks: "throw",
  });
  const runtime = ManagedRuntime.make(AppLayer(home, { native }));
  runtimes.push(runtime as never);
  const threadId = "thread-local" as ThreadId;
  const dispatch = (c: Command) => Effect.flatMap(Engine, (e) => e.dispatch(c));
  const { view, ledger } = await runtime.runPromise(
    Effect.gen(function* () {
      yield* dispatch({
        type: "thread.create",
        commandId: "c1" as CommandId,
        threadId,
        projectPath: home,
        route: { harness: "native", model: "qwen3:8b", effort: "medium" },
      });
      yield* dispatch({
        type: "turn.send",
        commandId: "c2" as CommandId,
        threadId,
        turnId: "t1" as TurnId,
        text: "Any docs?",
        mode: "build",
      });
      yield* Effect.flatMap(Reactor, (r) => r.drain);
      const sql = yield* SqlClient.SqlClient;
      return {
        view: yield* loadThreadView(threadId),
        ledger: yield* sql<{ access_mode: string; cost_usd: number }>`select access_mode, cost_usd from usage_ledger`,
      };
    }),
  );
  expect(view?.turns.at(-1)?.status).toBe("success");
  expect(view?.turns.at(-1)?.items).toContainEqual({ kind: "tool.call", toolUseId: "call_1", name: "glob", input: { pattern: "*.md" } });
  expect(ledger).toEqual([
    { access_mode: "local", cost_usd: 0 },
    { access_mode: "local", cost_usd: 0 },
  ]);
});

test("an endpoint that would send a key must be on https, unless it's on this machine; a keyless one may use plain http", async () => {
  const lan = `endpoints:
  lan:
    url: http://192.168.1.20:8000/v1
    access: local
    models:
      qwen3:8b: { tier: S, context: 32768 }
`;
  const load = (text: string, env: Record<string, string> = {}) =>
    loadEndpoints(homeWith(text), env, emptyKeychain).then(
      (r) => r.endpoints.map((e) => e.id).join(),
      (e: Error) => e.message,
    );
  const metered = await load(providers.replace("https://openrouter.ai", "http://openrouter.ai"));
  expect(metered).toContain("providers.yaml");
  expect(metered).toContain("endpoints.openrouter.url");
  expect(metered).toContain("https://");
  // A local endpoint with a key found for it would send the key in the clear.
  const keyed = await load(lan, { VERDANDI_LAN_API_KEY: "lan-key" });
  expect(keyed).toContain("endpoints.lan.url");
  expect(keyed).not.toContain("lan-key");
  expect(await load(lan)).toBe("lan");
  expect(await load(lan.replace("192.168.1.20", "localhost"), { VERDANDI_LAN_API_KEY: "lan-key" })).toBe("lan");
  expect(await load(lan.replace("192.168.1.20", "[::1]"), { VERDANDI_LAN_API_KEY: "lan-key" })).toBe("lan");
});
