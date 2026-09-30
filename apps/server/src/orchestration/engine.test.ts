import { afterEach, describe, expect, test } from "bun:test";
import type { Command, CommandId, Resolution, StoredEvent, ThreadId, TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { SqlLive } from "../persistence/db.ts";
import { AppLayer } from "./app.ts";
import { Engine, EngineLive } from "./engine.ts";
import { loadThreadView, project } from "./projector.ts";
import { HarnessRegistry, Reactor, ReactorLive } from "./reactor.ts";

const homes: string[] = [];
const runtimes: ManagedRuntime.ManagedRuntime<unknown, unknown>[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const h of homes.splice(0)) removeTempHome(h);
});

const threadId = "thread-1" as ThreadId;
const route = { harness: "fake", model: "fake", effort: "low" } as const;
let n = 0;
const id = <T>() => `id-${++n}` as T;

const start = (home: string, fake = makeFakeHarness(), options?: Parameters<typeof AppLayer>[2]) => {
  const runtime = ManagedRuntime.make(AppLayer(home, { fake }, options));
  runtimes.push(runtime as never);
  return { runtime, fake };
};
const newHome = () => {
  const h = makeTempHome();
  homes.push(h);
  return h;
};

const dispatch = (c: Command) =>
  Effect.gen(function* () {
    return yield* (yield* Engine).dispatch(c);
  });
const drain = Effect.gen(function* () {
  yield* (yield* Reactor).drain;
});
const view = loadThreadView(threadId);
const create: Command = { type: "thread.create", commandId: id<CommandId>(), threadId, projectPath: "C:/Users/a b/repo", route };
const send = (text: string, turnId = id<TurnId>()): Command => ({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId, text });

/** Completes with the id of the next request a harness raises, once it is committed. */
const nextRequest = Effect.gen(function* () {
  const raised = yield* Deferred.make<string>();
  yield* (yield* Engine).react((s) =>
    s.event.type === "approval.requested" || s.event.type === "user-input.requested"
      ? Deferred.succeed(raised, s.event.requestId).pipe(Effect.asVoid)
      : Effect.void,
  );
  return raised;
});

/** Sends `text`, answers the request it raises with `resolution`, and returns the view while pending and after. */
const answerTurn = (text: string, resolution: Resolution) =>
  Effect.gen(function* () {
    yield* dispatch(create);
    const raised = yield* nextRequest;
    yield* dispatch(send(text));
    const requestId = yield* Deferred.await(raised);
    const pending = yield* view;
    yield* dispatch({ type: "approval.respond", commandId: id<CommandId>(), threadId, requestId, resolution });
    yield* drain;
    return { pending: pending?.pendingRequests.map((r) => r.requestId), after: yield* view, requestId };
  });

const lastItem = (v: Effect.Success<typeof view>) => v?.turns.at(-1)?.items.at(-1);

describe("engine", () => {
  test("a sent turn completes and persists", async () => {
    const { runtime } = start(newHome());
    const v = await runtime.runPromise(
      Effect.gen(function* () {
        yield* dispatch(create);
        yield* dispatch(send("hi"));
        yield* drain;
        return yield* view;
      }),
    );
    expect(v?.busy).toBe(false);
    expect(v?.turns.map((t) => [t.status, t.items])).toEqual([["success", [{ kind: "assistant.message", text: "echo: hi" }]]]);
  });

  test("a steer is recorded in the running turn and the agent answers it", async () => {
    const { runtime } = start(newHome());
    const turnId = id<TurnId>();
    const v = await runtime.runPromise(
      Effect.gen(function* () {
        yield* dispatch(create);
        yield* dispatch(send("steer", turnId));
        yield* dispatch({ type: "turn.steer", commandId: id<CommandId>(), threadId, turnId, text: "go left" });
        yield* drain;
        return yield* view;
      }),
    );
    expect(v?.turns.map((t) => [t.status, t.items])).toEqual([
      [
        "success",
        [
          { kind: "user.steer", text: "go left" },
          { kind: "assistant.message", text: "steered: go left" },
        ],
      ],
    ]);
  });

  test("retrying a command returns the same receipt and appends nothing", async () => {
    const { runtime } = start(newHome());
    const c = send("hi");
    const [a, b, count] = await runtime.runPromise(
      Effect.gen(function* () {
        yield* dispatch(create);
        const a = yield* dispatch(c);
        const b = yield* dispatch(c);
        yield* drain;
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{ n: number }>`select count(*) as n from events where command_id = ${c.commandId}`;
        return [a, b, row?.n] as const;
      }),
    );
    expect(b).toEqual(a);
    expect(count).toBe(1);
  });

  test("a failed projection leaves no events", async () => {
    const failing = (s: StoredEvent) => (s.event.type === "turn.started" ? Effect.die("projection failed") : project(s));
    const { runtime } = start(newHome(), makeFakeHarness(), { project: failing });
    const [failed, count] = await runtime.runPromise(
      Effect.gen(function* () {
        yield* dispatch(create);
        const failed = yield* Effect.exit(dispatch(send("hi")));
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{ n: number }>`select count(*) as n from events`;
        const [receipts] = yield* sql<{ n: number }>`select count(*) as n from command_receipts`;
        return [failed._tag, [row?.n, receipts?.n]] as const;
      }),
    );
    expect(failed).toBe("Failure");
    expect(count).toEqual([1, 1]); // only thread.created and its receipt
  });

  test("harness failure ends the turn with an error", async () => {
    const { runtime } = start(newHome());
    const v = await runtime.runPromise(
      Effect.gen(function* () {
        yield* dispatch(create);
        yield* dispatch(send("fail"));
        yield* drain;
        yield* dispatch(send("again"));
        yield* drain;
        return yield* view;
      }),
    );
    expect(v?.turns.map((t) => [t.status, t.error])).toEqual([
      ["error", "fake failure"],
      ["success", undefined],
    ]);
  });

  test("resumes the harness session after restart", async () => {
    const home = newHome();
    const fake = makeFakeHarness();
    const first = start(home, fake).runtime;
    await first.runPromise(
      Effect.gen(function* () {
        yield* dispatch(create);
        yield* dispatch(send("one"));
        yield* drain;
      }),
    );
    await first.dispose();
    const second = start(home, fake).runtime;
    await second.runPromise(
      Effect.gen(function* () {
        yield* dispatch(send("two"));
        yield* drain;
      }),
    );
    expect(fake.calls[1]?.resumeSessionId).toBe("fake-session-1");
  });

  test("recovers running turns on startup", async () => {
    const home = newHome();
    const first = start(home).runtime;
    await first.runPromise(
      Effect.gen(function* () {
        yield* dispatch(create);
        yield* dispatch(send("hang"));
      }),
    );
    await first.dispose();
    const second = start(home).runtime;
    const v = await second.runPromise(
      Effect.gen(function* () {
        yield* dispatch(send("after"));
        yield* drain;
        return yield* view;
      }),
    );
    expect(v?.turns.map((t) => t.status)).toEqual(["interrupted", "success"]);
  });

  test("an allowed request lets the turn go on", async () => {
    const { runtime } = start(newHome());
    const { pending, after, requestId } = await runtime.runPromise(answerTurn("approve", { decision: "allow" }));
    expect(pending).toEqual([requestId]);
    expect(after?.pendingRequests).toEqual([]);
    expect(lastItem(after)).toEqual({ kind: "assistant.message", text: "edited a.txt" });
    expect(after?.turns.at(-1)?.status).toBe("success");
  });

  test("a denied request reaches the harness as a deny", async () => {
    const { runtime } = start(newHome());
    const { after } = await runtime.runPromise(answerTurn("approve", { decision: "deny" }));
    expect(after?.pendingRequests).toEqual([]);
    expect(lastItem(after)).toEqual({ kind: "assistant.message", text: "left a.txt alone" });
  });

  test("a user-input request is answered", async () => {
    const { runtime } = start(newHome());
    const { after } = await runtime.runPromise(answerTurn("ask", { decision: "answer", answers: { "Which color?": "Blue" } }));
    expect(lastItem(after)).toEqual({ kind: "assistant.message", text: "you picked Blue" });
  });

  test("a request pending when verdandid stops is denied on restart, and that is recorded", async () => {
    const home = newHome();
    const first = start(home).runtime;
    await first.runPromise(
      Effect.gen(function* () {
        yield* dispatch(create);
        const raised = yield* nextRequest;
        yield* dispatch(send("approve"));
        yield* Deferred.await(raised);
      }),
    );
    await first.dispose();
    const second = start(home).runtime;
    const [v, resolved] = await second.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ payload: string }>`select payload from events where type = 'approval.resolved'`;
        return [yield* view, rows.map((r) => JSON.parse(r.payload))] as const;
      }),
    );
    expect(v?.turns.map((t) => t.status)).toEqual(["interrupted"]);
    expect(v?.pendingRequests).toEqual([]);
    expect(resolved).toMatchObject([
      { resolution: { decision: "deny" }, reason: "verdandid stopped while this was waiting for an answer." },
    ]);
  });

  test("a dispatch interrupted after its commit still starts the turn", async () => {
    // A client that disconnects right after sending interrupts its dispatch fiber. A reaction
    // registered before the reactor's pauses the dispatch after commit, so the interrupt lands there.
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const pause = Layer.effectDiscard(
      Effect.gen(function* () {
        const engine = yield* Engine;
        yield* engine.react((s) =>
          s.event.type === "turn.started"
            ? Effect.andThen(
                Effect.sync(() => entered.resolve()),
                Effect.promise(() => proceed.promise),
              )
            : Effect.void,
        );
      }),
    );
    const layer = ReactorLive.pipe(
      Layer.provideMerge(pause.pipe(Layer.provideMerge(EngineLive()))),
      Layer.provideMerge(Layer.succeed(HarnessRegistry, { fake: makeFakeHarness() })),
      Layer.provideMerge(SqlLive(newHome())),
    );
    const runtime = ManagedRuntime.make(layer);
    runtimes.push(runtime as never);
    await runtime.runPromise(dispatch(create));
    const sending = runtime.runFork(dispatch(send("hi")));
    await entered.promise;
    const interrupting = runtime.runPromise(Fiber.interrupt(sending));
    proceed.resolve();
    await interrupting;
    const v = await runtime.runPromise(Effect.andThen(drain, view));
    expect(v?.busy).toBe(false);
    expect(v?.turns.map((t) => t.status)).toEqual(["success"]);
  });
});
