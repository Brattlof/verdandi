import { afterEach, describe, expect, test } from "bun:test";
import type { Command, CommandId, InteractionMode, Resolution, StoredEvent, ThreadId, TurnId } from "@verdandi/contracts";
import { Decide } from "@verdandi/decisions";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { rulesDecide } from "../routing/routing.ts";
import { AppLayer } from "./app.ts";
import { SqlLive } from "./db.ts";
import { Engine, EngineLive } from "./engine.ts";
import { migrations } from "./migrations.ts";
import { loadThreadView, project } from "./projector.ts";
import {
  ApprovalSettings,
  AttachmentsDir,
  HarnessRegistry,
  McpConfig,
  ProfileSkills,
  ProjectEscalation,
  Reactor,
  ReactorLive,
  ReviewSettings,
  ToolSettings,
  WorktreesDir,
} from "./reactor.ts";

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
const send = (text: string, turnId = id<TurnId>(), mode: InteractionMode = "build"): Command => ({
  type: "turn.send",
  commandId: id<CommandId>(),
  threadId,
  turnId,
  text,
  mode,
});

/** Completes with the id of the next request a harness raises, once it is committed. */
const nextRequest = Effect.gen(function* () {
  const raised = yield* Deferred.make<string>();
  yield* (yield* Engine).react((s) =>
    s.event.type === "approval.requested" || s.event.type === "user-input.requested" || s.event.type === "plan.requested"
      ? Deferred.succeed(raised, s.event.requestId).pipe(Effect.asVoid)
      : Effect.void,
  );
  return raised;
});

/** Completes once the harness session is bound to the thread. */
const sessionBound = Effect.gen(function* () {
  const bound = yield* Deferred.make<void>();
  yield* (yield* Engine).react((s) => (s.event.type === "harness.session.bound" ? Deferred.succeed(bound, undefined) : Effect.void));
  return bound;
});
const interrupt = (turnId: TurnId): Command => ({ type: "turn.interrupt", commandId: id<CommandId>(), threadId, turnId });

/** Sends `text`, answers the request it raises with `resolution`, and returns the view while pending and after. */
const answerTurn = (text: string, resolution: Resolution, mode: InteractionMode = "build") =>
  Effect.gen(function* () {
    yield* dispatch(create);
    const raised = yield* nextRequest;
    yield* dispatch(send(text, id<TurnId>(), mode));
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
    expect(count).toBe(3); // the first turn's task.started, turn.started and decision.recorded, once
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

  test("a route change applies from the next turn and shows in its usage", async () => {
    const { runtime, fake } = start(newHome());
    const models = await runtime.runPromise(
      Effect.gen(function* () {
        yield* dispatch(create);
        yield* dispatch(send("one"));
        yield* drain;
        yield* dispatch({
          type: "thread.route.set",
          commandId: id<CommandId>(),
          threadId,
          route: { ...route, model: "fake-2", effort: "high" },
        });
        yield* dispatch(send("two"));
        yield* drain;
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{ model: string }>`select model from usage_ledger order by rowid`;
      }),
    );
    expect(models.map((m) => m.model)).toEqual(["fake", "fake-2"]);
    expect(fake.calls.map((c) => [c.route.model, c.route.effort, c.resumeSessionId])).toEqual([
      ["fake", "low", undefined],
      ["fake-2", "high", "fake-session-1"],
    ]);
  });

  test("route changes sit between the turns they came between, and the migration rebuilds them from the log", async () => {
    const { runtime } = start(newHome());
    const setRoute = (model: string) =>
      dispatch({ type: "thread.route.set", commandId: id<CommandId>(), threadId, route: { ...route, model } });
    const [live, rebuilt] = await runtime.runPromise(
      Effect.gen(function* () {
        yield* dispatch(create);
        yield* setRoute("fake-2");
        yield* dispatch(send("one"));
        yield* drain;
        yield* setRoute("fake-3");
        const live = yield* view;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`drop table route_changes`;
        yield* migrations["5_route_changes"];
        yield* migrations["22_route_change_reasons"];
        return [live, yield* view] as const;
      }),
    );
    expect(live?.routeChanges.map((c) => [c.from.model, c.to.model, c.afterTurns])).toEqual([
      ["fake", "fake-2", 0],
      ["fake-2", "fake-3", 1],
    ]);
    expect(rebuilt).toEqual(live);
  });

  test("switching harness starts a fresh session on the new one", async () => {
    const other = makeFakeHarness();
    const runtime = ManagedRuntime.make(AppLayer(newHome(), { fake: makeFakeHarness(), "claude-code": other }));
    runtimes.push(runtime as never);
    const v = await runtime.runPromise(
      Effect.gen(function* () {
        yield* dispatch(create);
        yield* dispatch(send("one"));
        yield* drain;
        yield* dispatch({ type: "thread.route.set", commandId: id<CommandId>(), threadId, route: { ...route, harness: "claude-code" } });
        yield* dispatch(send("two"));
        yield* drain;
        return yield* view;
      }),
    );
    expect(other.calls.map((c) => c.resumeSessionId)).toEqual([undefined]);
    expect(v?.route.harness).toBe("claude-code");
    expect(v?.turns.map((t) => t.status)).toEqual(["success", "success"]);
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

  test("an interrupted turn ends as interrupted and the next turn continues its session", async () => {
    const { runtime, fake } = start(newHome());
    const turnId = id<TurnId>();
    const v = await runtime.runPromise(
      Effect.gen(function* () {
        yield* dispatch(create);
        const bound = yield* sessionBound;
        yield* dispatch(send("hang", turnId));
        yield* Deferred.await(bound);
        yield* dispatch(interrupt(turnId));
        yield* drain; // returns only once the hanging turn's fiber is interrupted
        yield* dispatch(send("after"));
        yield* drain;
        return yield* view;
      }),
    );
    expect(v?.turns.map((t) => t.status)).toEqual(["interrupted", "success"]);
    expect(fake.calls.map((c) => c.resumeSessionId)).toEqual([undefined, "fake-session-1"]);
  });

  test("text a stopped turn's harness streams while it winds down reaches no feed", async () => {
    const { runtime } = start(newHome());
    const [stopped, next] = [id<TurnId>(), id<TurnId>()];
    const deltas = await runtime.runPromise(
      Effect.gen(function* () {
        const engine = yield* Engine;
        yield* dispatch(create);
        const bound = yield* sessionBound;
        yield* dispatch(send("hang", stopped));
        yield* Deferred.await(bound);
        const seen: [TurnId, string][] = [];
        const [subscribed, nextDone] = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
        const feed = yield* engine.feed(threadId).pipe(
          Stream.runForEach((f) => {
            if (f.kind === "snapshot") return Deferred.succeed(subscribed, undefined);
            if (f.kind === "delta") seen.push([f.turnId, f.text]);
            const done = f.kind === "event" && f.stored.event.type === "turn.completed" && f.stored.event.turnId === next;
            return done ? Deferred.succeed(nextDone, undefined) : Effect.void;
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);
        // What the harness streams for the stopped turn, before and after the interrupt ends it.
        yield* engine.publishDelta(threadId, stopped, "partial");
        yield* dispatch(interrupt(stopped));
        yield* engine.publishDelta(threadId, stopped, "late");
        yield* drain;
        yield* dispatch(send("hi", next));
        yield* Deferred.await(nextDone);
        yield* Fiber.interrupt(feed);
        return seen;
      }),
    );
    expect(deltas).toEqual([
      [stopped, "partial"],
      [next, "echo: "],
      [next, "hi"],
    ]);
  });

  test("interrupting a turn denies its pending requests", async () => {
    const { runtime } = start(newHome());
    const turnId = id<TurnId>();
    const [v, resolved] = await runtime.runPromise(
      Effect.gen(function* () {
        yield* dispatch(create);
        const raised = yield* nextRequest;
        yield* dispatch(send("approve", turnId));
        yield* Deferred.await(raised);
        yield* dispatch(interrupt(turnId));
        yield* drain;
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ payload: string }>`select payload from events where type = 'approval.resolved'`;
        return [yield* view, rows.map((r) => JSON.parse(r.payload))] as const;
      }),
    );
    expect(v?.pendingRequests).toEqual([]);
    expect(v?.turns.map((t) => [t.status, t.items])).toEqual([["interrupted", []]]);
    expect(resolved).toMatchObject([{ resolution: { decision: "deny" }, reason: "The user interrupted the turn." }]);
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

  test("a turn runs in the mode it was sent in, and its view shows it", async () => {
    const { runtime, fake } = start(newHome());
    const v = await runtime.runPromise(
      Effect.gen(function* () {
        yield* dispatch(create);
        yield* dispatch(send("one", id<TurnId>(), "ask"));
        yield* drain;
        yield* dispatch(send("two"));
        yield* drain;
        return yield* view;
      }),
    );
    expect(fake.calls.map((c) => c.mode)).toEqual(["ask", "build"]);
    expect(v?.turns.map((t) => t.mode)).toEqual(["ask", "build"]);
  });

  test("an approved plan is recorded and the turn goes on building", async () => {
    const { runtime } = start(newHome());
    const { pending, after, requestId } = await runtime.runPromise(answerTurn("plan", { decision: "allow" }, "plan"));
    expect(pending).toEqual([requestId]);
    expect(after?.pendingRequests).toEqual([]);
    expect(after?.turns.at(-1)?.items).toEqual([
      { kind: "plan", requestId, text: "1. Edit a.txt" },
      { kind: "assistant.message", text: "built the plan" },
    ]);
  });

  test("a plan approved with the user's edit builds from the edit, and the thread keeps both after a restart", async () => {
    const home = newHome();
    const first = start(home).runtime;
    const { requestId } = await first.runPromise(answerTurn("plan", { decision: "allow", plan: "1. Edit b.txt" }, "plan"));
    await first.dispose();
    const reloaded = await start(home).runtime.runPromise(view);
    expect(reloaded?.turns.at(-1)?.items).toEqual([
      { kind: "plan", requestId, text: "1. Edit a.txt", edited: "1. Edit b.txt" },
      { kind: "assistant.message", text: "built the plan: 1. Edit b.txt" },
    ]);
  });

  test("a rejected plan's feedback reaches the harness", async () => {
    const { runtime } = start(newHome());
    const { after } = await runtime.runPromise(answerTurn("plan", { decision: "deny", feedback: "smaller steps" }, "plan"));
    expect(lastItem(after)).toEqual({ kind: "assistant.message", text: "kept planning: smaller steps" });
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
      Layer.provideMerge(Layer.succeed(AttachmentsDir, "unused")),
      Layer.provideMerge(Layer.succeed(McpConfig, () => ({ servers: [], notices: [], trust: [], project: [] }))),
      Layer.provideMerge(Layer.succeed(WorktreesDir, "unused")),
      Layer.provideMerge(Layer.succeed(ToolSettings, { approveMemorySaves: false, memoryNudgeEvery: 0 })),
      Layer.provideMerge(
        Layer.succeed(ProjectEscalation, () =>
          Effect.succeed({ verifiers: [], fromProject: false, repeatedErrors: 0, delegation: { maxConcurrent: 1, maxDepth: 0 } }),
        ),
      ),
      Layer.provideMerge(Layer.succeed(Decide, rulesDecide)),
      Layer.provideMerge(Layer.succeed(ProfileSkills, { profile: "unused", archive: "unused", extra: [] })),
      Layer.provideMerge(Layer.succeed(ReviewSettings, { enabled: false, allowMetered: false })),
      Layer.provideMerge(Layer.succeed(ApprovalSettings, { smart: false })),
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
