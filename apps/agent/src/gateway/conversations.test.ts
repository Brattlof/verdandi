import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandId } from "@verdandi/contracts";
import { gitHeavyTimeout, makeFakeChannel, makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime, type Scope } from "effect";
import { ensureWorkspace } from "../home/workspace.ts";
import { connect } from "../rpc/client.ts";
import { ServerInfo, ServerLayer } from "../rpc/server.ts";
import { defaultAccess } from "./access.ts";
import { possibleRepeat } from "./gateway-outbox.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const owner = { id: "1", name: "Owner" };
const friend = { id: "2", name: "Friend" };
const config = { fake: { ...defaultAccess, allowFrom: ["1", "2"] } };

// A verdandid with the fake channel. Each turn checkpoints the workspace with git, slow on Windows: tests get gitHeavyTimeout.
const start = async (home: string, channel: ReturnType<typeof makeFakeChannel>) => {
  // New conversations run in the workspace; its policy routes them to the fake harness.
  const policy = join(ensureWorkspace(home), ".verdandi");
  mkdirSync(policy, { recursive: true });
  writeFileSync(
    join(policy, "routing.yaml"),
    [
      "minConfidence: 1",
      "targets:",
      "  mid: { harness: fake, provider: fake, model: fake }",
      "fallback: { prefer: [mid], effort: medium }",
    ].join(String.fromCharCode(10)),
  );
  const runtime = ManagedRuntime.make(ServerLayer(home, { fake: makeFakeHarness() }, { gateway: { config, adapters: [channel.adapter] } }));
  const info = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ServerInfo;
    }),
  );
  const call = <A, E>(f: (client: Effect.Success<ReturnType<typeof connect>>) => Effect.Effect<A, E, Scope.Scope>) =>
    Effect.runPromise(Effect.scoped(Effect.flatMap(connect(info), f)));
  return { call, stop: () => runtime.dispose() };
};

const query = <T>(home: string, sql: string) => {
  const db = new Database(join(home, "verdandi.db"), { readonly: true });
  try {
    return db.query<T, []>(sql).all();
  } finally {
    db.close();
  }
};

test(
  "a reply cut off between attempt and report is sent once more after a restart, to the bound chat only, marked as a possible repeat",
  async () => {
    const home = makeTempHome();
    cleanups.push(() => removeTempHome(home));
    const first = makeFakeChannel({ hold: (m) => m.text.includes("echo: hello there") });
    let server = await start(home, first);
    cleanups.push(() => server.stop());

    first.receive(owner, "hello there");
    await first.nextHeld();
    await server.stop();
    expect(query<{ state: string }>(home, "select state from deliveries")).toEqual([{ state: "attempted" }]);

    const second = makeFakeChannel();
    server = await start(home, second);
    const resent = await second.next((s) => s.text.includes("echo: hello there"));
    expect(resent.chatId).toBe("1");
    expect(resent.text.startsWith(possibleRepeat)).toBe(true);
    // Nothing else went anywhere: no second copy, no other chat.
    expect(second.sent.filter((s) => s.text.includes("hello there"))).toHaveLength(1);
    expect([...first.sent, ...second.sent].every((s) => s.chatId === "1")).toBe(true);
    await server.stop();
    expect(query<{ state: string; attempts: number }>(home, "select state, attempts from deliveries")).toEqual([
      { state: "sent", attempts: 2 },
    ]);
  },
  gitHeavyTimeout,
);

test(
  "a chat's message starts a thread in the workspace bound to it, a request comes with buttons the owner presses, and /new starts over",
  async () => {
    const home = makeTempHome();
    cleanups.push(() => removeTempHome(home));
    const channel = makeFakeChannel();
    const server = await start(home, channel);
    cleanups.push(() => server.stop());
    await server.call((c) =>
      c.CommandDispatch({ type: "gateway.owner.set", commandId: crypto.randomUUID() as CommandId, platform: "fake", senderId: "1" }),
    );

    channel.receive(owner, "approve");
    const request = await channel.next((s) => (s.buttons?.length ?? 0) > 0);
    expect(request).toMatchObject({ chatId: "1", text: expect.stringContaining("The agent asks to use") });
    const allow = request.buttons?.[0]?.command.split(" ") ?? [];
    // A sender who isn't the owner can't press it.
    channel.receive(friend, "", { chatId: "1", command: { name: allow[0] ?? "", args: allow.slice(1) } });
    expect(await channel.next((s) => s.chatId === "1" && s.text.startsWith("Only the owner"))).toBeDefined();
    channel.receive(owner, "", { command: { name: allow[0] ?? "", args: allow.slice(1) } });
    expect(await channel.next((s) => s.text === "Allowed.")).toBeDefined();
    await channel.next((s) => s.chatId === "1" && !s.buttons && s.text !== "Working on it…" && s.text !== "Allowed.");

    const [thread] = query<{ id: string; path: string; confined: number }>(
      home,
      "select t.id, p.path, t.confined from threads t join projects p on p.id = t.project_id",
    );
    expect(thread?.path.endsWith("workspace")).toBe(true);
    // Only the owner writes in this DM, so it keeps workspace.yaml's folders; a friend's DM doesn't.
    expect(thread?.confined).toBe(0);
    channel.receive(friend, "hi");
    await channel.next((s) => s.chatId === "2" && s.text.includes("echo: hi"));
    expect(query<{ confined: number }>(home, "select confined from threads order by rowid")).toEqual([{ confined: 0 }, { confined: 1 }]);
    // Nor does it get the tools that reach the owner's sessions and memory.
    channel.receive(friend, 'tool session_search {"query":"approve","allProjects":true}');
    await channel.next((s) => s.chatId === "2" && s.text.includes("called session_search"));
    expect(
      query<{ payload: string }>(home, "select payload from items where payload like '%tool.result%'").map(
        (r) => (JSON.parse(r.payload) as { content: string }).content,
      ),
    ).toContain("There's no Verdandi tool session_search.");

    channel.receive(owner, "", { command: { name: "new", args: [] } });
    await channel.next((s) => s.text.startsWith("Your next message here starts a new conversation"));
    channel.receive(owner, "again");
    await channel.next((s) => s.text.includes("echo: again"));
    const bindings = query<{ thread_id: string }>(home, "select thread_id from channel_bindings where key = 'fake:1'");
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.thread_id).not.toBe(thread?.id);
  },
  gitHeavyTimeout,
);
