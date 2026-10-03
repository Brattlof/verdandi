import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, ThreadId, TurnId } from "@verdandi/contracts";
import { makeNativeAdapter } from "@verdandi/harness-native";
import { type FakeReply, makeFakeAnthropic, makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { providers } from "../cli/doctor.ts";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { loadThreadView } from "../event-store/projector.ts";
import { Reactor } from "../event-store/reactor.ts";

const homes: string[] = [];
const runtimes: ManagedRuntime.ManagedRuntime<unknown, unknown>[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const h of homes.splice(0)) removeTempHome(h);
});

const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
/** Fails like the API's 529, quick to retry, so three of them outlast the SDK's two retries. */
const overloaded: FakeReply = {
  error: { status: 529, type: "overloaded_error", message: "Overloaded" },
  headers: { "retry-after-ms": "1" },
};
const fixed: FakeReply = { blocks: [{ type: "text", text: "Fixed." }] };
const TEXT = "Fix the typo in src/a.ts";

/** verdandid on the native harness and the fake provider, routing the project's code.edit.local tasks to `prefer`. */
const start = (script: readonly FakeReply[], prefer: readonly string[]) => {
  const home = makeTempHome();
  homes.push(home);
  mkdirSync(join(home, ".verdandi"), { recursive: true });
  const target = (model: string) => `{ harness: native, provider: anthropic, model: ${model} }`;
  writeFileSync(
    join(home, ".verdandi", "routing.yaml"),
    `targets:\n  sonnet: ${target(SONNET)}\n  opus: ${target(OPUS)}\nroutes:\n  code.edit.local: { prefer: [${prefer.join(", ")}], effort: medium }\n`,
  );
  const fake = makeFakeAnthropic(script);
  const native = makeNativeAdapter({
    apiKey: "sk-ant-test",
    sessionsDir: join(home, "native-sessions"),
    reach: { home, folders: [], readable: [] },
    terminal: { run: async () => ({ exitCode: 0, output: "", durationMs: 0 }), outputs: join(home, "terminal-output") },
    fetch: fake.fetch,
    cacheBreaks: "throw",
  });
  const runtime = ManagedRuntime.make(AppLayer(home, { native }));
  runtimes.push(runtime as never);
  let n = 0;
  const id = () => `c${++n}` as CommandId;
  const dispatch = (c: Command) => Effect.flatMap(Engine, (e) => e.dispatch(c));
  /** Sends `text` as a turn on `threadId`, creating the thread first when `create`, and waits until nothing runs. */
  const turn = (threadId: string, turnId: string, create = false, text = TEXT) =>
    runtime.runPromise(
      Effect.gen(function* () {
        const thread = threadId as ThreadId;
        if (create) yield* dispatch({ type: "thread.create", commandId: id(), threadId: thread, projectPath: home });
        yield* dispatch({ type: "turn.send", commandId: id(), threadId: thread, turnId: turnId as TurnId, text, mode: "build" });
        yield* Effect.flatMap(Reactor, (r) => r.drain);
        return yield* loadThreadView(threadId as ThreadId);
      }),
    );
  const query = <A extends object>(q: string) => runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(q)));
  return { home, fake, turn, query, models: () => fake.requests.map((r) => r.body.model) };
};

test("a model that stays overloaded past the SDK's retries ends the turn naming its provider, and the next routed task avoids it", async () => {
  const { home, turn, query, models } = start([overloaded, overloaded, overloaded, fixed], ["sonnet"]);

  const failed = (await turn("t1", "u1", true))?.turns.at(-1);
  expect(failed?.status).toBe("error");
  expect(failed?.error).toMatch(
    /^anthropic is overloaded on claude-sonnet-5-5 until \d\d:\d\d UTC, and no other healthy target on native is on code\.edit\.local's route or the default route: try again later, or pick another route\. The API said: 529 Overloaded$/,
  );
  expect(await query<{ provider: string; model: string; reason: string }>("select provider, model, reason from provider_health")).toEqual([
    { provider: "anthropic", model: SONNET, reason: "overloaded" },
  ]);
  const doctor = await providers(home);
  expect(doctor.status).toBe("warn");
  expect(doctor.detail).toMatch(
    /^anthropic is overloaded on claude-sonnet-5-5 until \d\d:\d\d UTC \(529 Overloaded\)\. New tasks route around it/,
  );

  const next = await turn("t2", "u2", true);
  expect(next?.turns.at(-1)?.status).toBe("success");
  expect(next?.route.model).toBe(OPUS);
  expect(next?.task?.reason).toMatch(
    /^Looks like code\.edit\.local \(rules: "fix", "typo"\), but anthropic is overloaded on claude-sonnet-5-5 until \d\d:\d\d UTC, so it runs on claude-opus-5-5 at medium effort instead\.$/,
  );
  expect(models()).toEqual([SONNET, SONNET, SONNET, OPUS]);
});

test("an overloaded model's turn finishes on a fallback, and the next turn starts on the route's model again once it's healthy", async () => {
  const { turn, query, models } = start([overloaded, overloaded, overloaded, fixed, fixed], ["sonnet", "opus"]);

  const first = await turn("t1", "u1", true);
  const done = first?.turns.at(-1);
  expect(done?.status).toBe("success");
  expect(done?.items).toContainEqual({
    kind: "route.switch",
    from: { harness: "native", model: SONNET, effort: "medium" },
    to: { harness: "native", model: OPUS, effort: "medium" },
    reason: expect.stringMatching(
      /^anthropic is overloaded on claude-sonnet-5-5 until \d\d:\d\d UTC, so this turn falls back to claude-opus-5-5 at medium effort, from code\.edit\.local's route\.$/,
    ),
  });
  // The fallback is the turn's alone: the thread and its task stay on their route.
  expect(first?.route.model).toBe(SONNET);
  const [outcome] = await query<{ payload: string }>("select payload from task_outcomes");
  expect(JSON.parse(outcome?.payload ?? "{}")).toMatchObject({ v: 4, route: { model: SONNET }, fallbacks: 1 });

  // No reset was reported, so the next turn goes back to the route, and its success ends the failure.
  const second = await turn("t1", "u2");
  expect(second?.turns.at(-1)?.status).toBe("success");
  expect(models()).toEqual([SONNET, SONNET, SONNET, OPUS, SONNET]);
  expect(await query("select * from provider_health")).toEqual([]);
});

test("a rate limit whose reset is still ahead keeps the thread's next turn on the fallback", async () => {
  const limited: FakeReply = {
    error: { status: 429, type: "rate_limit_error", message: "Rate limited" },
    headers: { "retry-after": "3600", "x-should-retry": "false" },
  };
  const { turn, models } = start([limited, fixed, fixed], ["sonnet", "opus"]);

  expect((await turn("t1", "u1", true))?.turns.at(-1)?.status).toBe("success");
  const second = await turn("t1", "u2");
  const sticky = second?.turns.at(-1);
  expect(sticky?.status).toBe("success");
  expect(sticky?.items[0]).toMatchObject({
    kind: "route.switch",
    to: { model: OPUS },
    reason: expect.stringMatching(/^anthropic is rate-limiting claude-sonnet-5-5 until \d\d:\d\d UTC, so this turn falls back/),
  });
  expect(models()).toEqual([SONNET, OPUS, OPUS]);
});

test("a route the user picked fails visibly instead of falling back, naming the way on", async () => {
  const home = makeTempHome();
  homes.push(home);
  const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness() }));
  runtimes.push(runtime as never);
  const threadId = "t1" as ThreadId;
  const view = await runtime.runPromise(
    Effect.gen(function* () {
      const engine = yield* Engine;
      const route = { harness: "fake", model: "fake", effort: "low" } as const;
      yield* engine.dispatch({ type: "thread.create", commandId: "c1" as CommandId, threadId, projectPath: home, route });
      yield* engine.dispatch({
        type: "turn.send",
        commandId: "c2" as CommandId,
        threadId,
        turnId: "u1" as TurnId,
        text: "provider overloaded",
        mode: "build",
      });
      yield* Effect.flatMap(Reactor, (r) => r.drain);
      return yield* loadThreadView(threadId);
    }),
  );
  const failed = view?.turns.at(-1);
  expect(failed?.status).toBe("error");
  expect(failed?.error).toMatch(
    /^fake is overloaded on fake until \d\d:\d\d UTC, and you picked this route, so Verdandi doesn't move it: pick another route to go on\.$/,
  );
  expect(failed?.items.some((i) => i.kind === "route.switch")).toBe(false);
});

test("auto effort moves a light turn's effort and back, while every request's system prompt and tools stay byte-identical", async () => {
  const { fake, turn } = start([fixed, fixed, fixed], ["sonnet"]);

  await turn("t1", "u1", true);
  const light = (await turn("t1", "u2", false, "go ahead"))?.turns.at(-1);
  expect(light?.items[0]).toEqual({
    kind: "effort",
    from: "medium",
    to: "low",
    reason: "This turn looks light (a confirmation), so it runs at low effort, one level below the task's medium.",
  });
  const plain = (await turn("t1", "u3", false, "Now add a --since flag to the export command"))?.turns.at(-1);
  expect(plain?.items.some((i) => i.kind === "effort")).toBe(false);

  const [first, second, third] = fake.requests;
  // The task's effort stays the top-level one; the turn's own goes in as an effort message, which extends the cache.
  expect([first, second, third].map((r) => (r?.body.output_config as { effort: string } | undefined)?.effort)).toEqual([
    "medium",
    "medium",
    "medium",
  ]);
  const efforts = (r: typeof first) =>
    ((r?.body.messages ?? []) as { role: string; output_config?: unknown }[])
      .filter((m) => m.role === "system")
      .map((m) => m.output_config);
  expect(efforts(first)).toEqual([]);
  expect(efforts(second)).toEqual([{ effort: "low" }]);
  expect(efforts(third)).toEqual([{ effort: "low" }, { effort: "medium" }]);
  expect([first, second, third].map((r) => r?.headers.get("anthropic-beta") ?? null)).toEqual([
    null,
    "mid-conversation-output-config-2026-07-01",
    "mid-conversation-output-config-2026-07-01",
  ]);
  for (const r of [second, third]) {
    expect(JSON.stringify(r?.body.system)).toBe(JSON.stringify(first?.body.system));
    expect(JSON.stringify(r?.body.tools)).toBe(JSON.stringify(first?.body.tools));
  }
});
