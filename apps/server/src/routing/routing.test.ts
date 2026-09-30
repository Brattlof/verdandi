import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BudgetMode,
  type Command,
  type CommandId,
  type CommandRejected,
  describeRouteChange,
  type Resolution,
  type Route,
  type RouteDecision,
  type TaskId,
  type TaskOutcome,
  type ThreadId,
  type TurnId,
} from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Deferred, Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../orchestration/app.ts";
import { Engine } from "../orchestration/engine.ts";
import { loadThreadView } from "../orchestration/projector.ts";
import { Reactor } from "../orchestration/reactor.ts";

const dirs: string[] = [];
const runtimes: ManagedRuntime.ManagedRuntime<unknown, unknown>[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const d of dirs.splice(0)) removeTempHome(d);
});

const tempDir = () => {
  const d = makeTempHome();
  dirs.push(d);
  return d;
};

/** Routes search to the small fake model and debugging to the large one; the built-in Claude Code targets aren't running. */
const policy = `
targets:
  small: { harness: fake, provider: fake, model: fake-small }
  large: { harness: fake, provider: fake, model: fake-large }
routes:
  ask.search: { prefer: [small], effort: low }
  debug.investigate: { prefer: [large], effort: high }
`;
const SEARCH = "Where is the auth middleware?";
const DEBUG = "Why does the upload keep failing? Investigate the root cause.";

/** A project folder with `routing` as its `.verdandi/routing.yaml`, and verdandid running only the fake harness. */
const setup = (routing = policy) => {
  const projectPath = tempDir();
  mkdirSync(join(projectPath, ".verdandi"));
  writeFileSync(join(projectPath, ".verdandi", "routing.yaml"), routing);
  const fake = makeFakeHarness();
  const runtime = ManagedRuntime.make(AppLayer(tempDir(), { fake }));
  runtimes.push(runtime as never);
  return {
    projectPath,
    fake,
    run: <A, E>(effect: Effect.Effect<A, E, Engine | Reactor | SqlClient.SqlClient>) => runtime.runPromise(effect),
  };
};

let n = 0;
const id = <T>() => `id-${++n}` as T;
const threadId = "thread-1" as ThreadId;
const pinned: Route = { harness: "fake", model: "fake", effort: "medium" };

const dispatch = (c: Command) =>
  Effect.gen(function* () {
    return yield* (yield* Engine).dispatch(c);
  });
const drain = Effect.gen(function* () {
  yield* (yield* Reactor).drain;
});
const create = (projectPath: string, route?: Route): Command => ({
  type: "thread.create",
  commandId: id<CommandId>(),
  threadId,
  projectPath,
  ...(route ? { route } : {}),
});
const send = (text: string, turnId = id<TurnId>()): Command => ({
  type: "turn.send",
  commandId: id<CommandId>(),
  threadId,
  turnId,
  text,
  mode: "build",
});
const view = loadThreadView(threadId);

describe("routing each new task", () => {
  test("a task without a pin is routed, runs on the routed route, and says why", async () => {
    const { projectPath, fake, run } = setup();
    const turnId = id<TurnId>();
    const v = await run(
      Effect.gen(function* () {
        yield* dispatch(create(projectPath));
        yield* dispatch(send(SEARCH, turnId));
        yield* drain;
        const [trajectory] = yield* (yield* SqlClient.SqlClient)<{ payload: string }>`select payload from trajectories`;
        expect(JSON.parse(trajectory?.payload ?? "{}").route).toEqual({ harness: "fake", model: "fake-small", effort: "low" });
        return yield* view;
      }),
    );
    expect(v?.route).toEqual({ harness: "fake", model: "fake-small", effort: "low" });
    expect(v?.pinned).toBe(false);
    expect(v?.task).toEqual({
      taskId: turnId as string as TaskId,
      source: "policy",
      reason: "Looks like ask.search, so it runs on fake-small at low effort.",
    });
    expect(fake.calls.map((c) => c.route.model)).toEqual(["fake-small"]);
  });

  test("a pin skips the router", async () => {
    const { projectPath, fake, run } = setup();
    const v = await run(
      Effect.gen(function* () {
        yield* dispatch(create(projectPath, pinned));
        yield* dispatch(send(DEBUG));
        yield* drain;
        return yield* view;
      }),
    );
    expect(v?.route).toEqual(pinned);
    expect(v?.task).toMatchObject({ source: "pin", reason: "You pinned fake at medium effort." });
    expect(fake.calls.map((c) => c.route)).toEqual([pinned]);
  });

  test("the user's pick is an override on the routed task's outcome, and pins the thread", async () => {
    const { projectPath, fake, run } = setup();
    const picked: Route = { harness: "fake", model: "fake-large", effort: "high" };
    const { outcome, v } = await run(
      Effect.gen(function* () {
        yield* dispatch(create(projectPath));
        yield* dispatch(send(SEARCH));
        yield* drain;
        yield* dispatch({ type: "thread.route.set", commandId: id<CommandId>(), threadId, route: picked });
        yield* drain;
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{ payload: string }>`select payload from task_outcomes`;
        yield* dispatch(send(SEARCH));
        yield* drain;
        return { outcome: JSON.parse(row?.payload ?? "{}") as TaskOutcome, v: yield* view };
      }),
    );
    expect(outcome.userOverride).toEqual({ from: { harness: "fake", model: "fake-small", effort: "low" }, to: picked });
    expect(v?.pinned).toBe(true);
    expect(v?.task?.source).toBe("pin");
    expect(fake.calls.map((c) => c.route.model)).toEqual(["fake-small", "fake-large"]);
  });

  test("picking the routed route pins it without counting as an override", async () => {
    const { projectPath, run } = setup();
    const { v, outcome } = await run(
      Effect.gen(function* () {
        yield* dispatch(create(projectPath));
        yield* dispatch(send(SEARCH));
        yield* drain;
        const routed = (yield* view)?.route;
        if (!routed) throw new Error("no thread");
        yield* dispatch({ type: "thread.route.set", commandId: id<CommandId>(), threadId, route: routed });
        yield* drain;
        const [row] = yield* (yield* SqlClient.SqlClient)<{ payload: string }>`select payload from task_outcomes`;
        return { v: yield* view, outcome: JSON.parse(row?.payload ?? "{}") as TaskOutcome };
      }),
    );
    expect(v?.pinned).toBe(true);
    expect(v?.routeChanges.map((c) => describeRouteChange(c.from, c.to))).toEqual([""]);
    expect(outcome.userOverride).toBeUndefined();
  });

  test("unpinning lets the router pick the next task's route", async () => {
    const { projectPath, fake, run } = setup();
    const v = await run(
      Effect.gen(function* () {
        yield* dispatch(create(projectPath, pinned));
        yield* dispatch(send(SEARCH));
        yield* drain;
        yield* dispatch({ type: "thread.route.unpin", commandId: id<CommandId>(), threadId });
        const unpinned = yield* view;
        expect(unpinned?.pinned).toBe(false);
        expect(unpinned?.task).toBeNull();
        yield* dispatch(send(DEBUG));
        yield* drain;
        return yield* view;
      }),
    );
    expect(v?.task?.source).toBe("policy");
    expect(fake.calls.map((c) => c.route)).toEqual([pinned, { harness: "fake", model: "fake-large", effort: "high" }]);
  });

  test("the thread's budget mode routes its next task, the running turn keeps its route, and clearing it restores the policy's", async () => {
    const { projectPath, fake, run } = setup(`${policy}  ask.search: { prefer: [small], effort: low, max: { prefer: [large] } }
fallback: { prefer: [small], effort: low }
`);
    const budget = (mode: BudgetMode | null): Command => ({ type: "thread.budget.set", commandId: id<CommandId>(), threadId, mode });
    const decision = (taskId: TurnId) =>
      Effect.gen(function* () {
        const [row] = yield* (yield* SqlClient.SqlClient)<{
          payload: string;
        }>`select payload from route_decisions where task_id = ${taskId}`;
        return JSON.parse(row?.payload ?? "{}") as RouteDecision;
      });
    const maxTurn = id<TurnId>();
    const clearedTurn = id<TurnId>();
    const { during, routed, cleared, v } = await run(
      Effect.gen(function* () {
        yield* dispatch(create(projectPath));
        yield* dispatch(send("gate"));
        yield* dispatch(budget("max"));
        const during = yield* view;
        fake.release();
        yield* drain;
        yield* dispatch(send(SEARCH, maxTurn));
        yield* drain;
        yield* dispatch(budget(null));
        yield* dispatch(send(SEARCH, clearedTurn));
        yield* drain;
        return { during, routed: yield* decision(maxTurn), cleared: yield* decision(clearedTurn), v: yield* view };
      }),
    );
    // Set mid-turn: the running turn keeps its route, and the next turn starts a task routed under it.
    expect(during).toMatchObject({ budgetMode: "max", task: null, busy: true });
    expect(fake.calls.map((c) => c.route.model)).toEqual(["fake-small", "fake-large", "fake-large"]);
    expect(routed.reason).toBe("Looks like ask.search, so in max mode it runs on fake-large at low effort.");
    expect(v?.budgetMode).toBeNull();
    expect(cleared.trace.find((t) => t.stage === "policy")?.note).toContain("in balanced mode");
  });

  test("a pinned thread keeps its task when the budget mode changes, and routes under it once unpinned", async () => {
    const { projectPath, run } = setup();
    const v = await run(
      Effect.gen(function* () {
        yield* dispatch(create(projectPath, pinned));
        yield* dispatch(send(SEARCH));
        yield* drain;
        yield* dispatch({ type: "thread.budget.set", commandId: id<CommandId>(), threadId, mode: "thrifty" });
        const kept = yield* view;
        expect(kept?.task?.source).toBe("pin");
        expect(kept?.budgetMode).toBe("thrifty");
        yield* dispatch({ type: "thread.route.unpin", commandId: id<CommandId>(), threadId });
        yield* dispatch(send(SEARCH));
        yield* drain;
        return yield* view;
      }),
    );
    expect(v?.task?.source).toBe("policy");
  });

  test("a broken project policy rejects a routed task, naming the file and key, but not a pinned one", async () => {
    const { projectPath, run } = setup("routes:\n  review: { effort: extreme }\n");
    const rejected = await run(
      Effect.gen(function* () {
        yield* dispatch(create(projectPath));
        return yield* Effect.flip(dispatch(send(SEARCH)));
      }),
    );
    expect((rejected as CommandRejected).reason).toBe("InvalidPolicy");
    expect(rejected.message).toContain(join(projectPath, ".verdandi", "routing.yaml"));
    expect(rejected.message).toContain(`["routes"]["review"]["effort"]`);

    const v = await run(
      Effect.gen(function* () {
        yield* dispatch({ type: "thread.route.set", commandId: id<CommandId>(), threadId, route: pinned });
        yield* dispatch(send(SEARCH));
        yield* drain;
        return yield* view;
      }),
    );
    expect(v?.task?.source).toBe("pin");
  });
});

describe("the decision layer", () => {
  type Logged = { turn_id: string; kind: string; backend: string; low_confidence: number; answer: string };
  const logged = Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<Logged>`select turn_id, kind, backend, low_confidence, answer from decisions order by seq, idx`,
  );

  test("classifies each routed task and logs it, and a follow-up it calls a correction lowers the task's satisfaction", async () => {
    const { projectPath, run } = setup();
    const first = id<TurnId>();
    const second = id<TurnId>();
    const { rows, outcome } = await run(
      Effect.gen(function* () {
        yield* dispatch(create(projectPath));
        yield* dispatch(send(SEARCH, first));
        yield* drain;
        yield* dispatch(send("No, that's not what I asked for", second));
        yield* drain;
        const [row] = yield* (yield* SqlClient.SqlClient)<{ payload: string }>`select payload from task_outcomes`;
        return { rows: yield* logged, outcome: JSON.parse(row?.payload ?? "{}") as TaskOutcome };
      }),
    );
    expect(rows.map((r) => [r.turn_id, r.kind, r.backend, r.low_confidence])).toEqual([
      [first, "routing.task-class", "rules", 0],
      [first, "routing.difficulty", "rules", 0],
      [second, "follow-up.correcting", "rules", 0],
    ]);
    expect(JSON.parse(rows[0]?.answer ?? "{}")).toMatchObject({ type: "choice", answer: "ask.search" });
    expect(outcome.implicitSatisfaction).toBe(0);
  });

  test("a low-confidence classification takes the budget mode's safe default", async () => {
    const { projectPath, fake, run } = setup(`${policy}fallback: { prefer: [large], effort: medium }\n`);
    const { v, rows } = await run(
      Effect.gen(function* () {
        yield* dispatch(create(projectPath));
        // "refactor" hints at a small edit and a large refactor alike.
        yield* dispatch(send("Refactor the parser"));
        yield* drain;
        return { v: yield* view, rows: yield* logged };
      }),
    );
    expect(rows[0]).toMatchObject({ kind: "routing.task-class", low_confidence: 1 });
    expect(v?.task?.reason).toStartWith("Not sure what kind of task this is");
    expect(fake.calls.map((c) => c.route)).toEqual([{ harness: "fake", model: "fake-large", effort: "medium" }]);
  });
});

describe("an approved plan's build", () => {
  // The fake's "plan" text is chat.general at confidence 0.5, so the test lowers minConfidence to route it by class.
  // Its models are free, so only a move to a stronger one passes the switch-cost gate: the plan runs small, the build large.
  const planned = `${policy}  chat.general: { prefer: [large], effort: medium, plan: { prefer: [small], effort: high } }
minConfidence: 0.4
`;
  const large: Route = { harness: "fake", model: "fake-large", effort: "medium" };

  /** Sends the fake's "plan" in plan mode, answers its plan with `resolution`, and returns the pending request and the view after. */
  const planTurn = (projectPath: string, resolution: Resolution, route?: Route) =>
    Effect.gen(function* () {
      const engine = yield* Engine;
      const raised = yield* Deferred.make<void>();
      yield* engine.react((s) =>
        s.event.type === "plan.requested" ? Deferred.succeed(raised, undefined).pipe(Effect.asVoid) : Effect.void,
      );
      yield* dispatch(create(projectPath, route));
      yield* dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId: id<TurnId>(), text: "plan", mode: "plan" });
      yield* Deferred.await(raised);
      const request = (yield* view)?.pendingRequests[0];
      if (request?.type !== "plan.requested") throw new Error("no plan request");
      yield* dispatch({ type: "approval.respond", commandId: id<CommandId>(), threadId, requestId: request.requestId, resolution });
      yield* drain;
      return { request, after: yield* view };
    });
  test("moves the rest of the turn to the class's build route and says why", async () => {
    const s = setup(planned);
    const { request, after } = await s.run(planTurn(s.projectPath, { decision: "allow" }));
    const reason = "The plan for this chat.general task is approved, so it runs on fake-large at medium effort.";
    expect(request.execute?.reason).toBe(reason);
    expect(s.fake.calls.map((c) => c.route.model)).toEqual(["fake-small"]);
    expect(s.fake.reroutes.map((r) => r.route)).toEqual([large]);
    expect(after?.route).toEqual(large);
    expect(after?.task).toMatchObject({ source: "policy", reason });
    const turn = after?.turns[0];
    expect(turn?.items.map((i) => i.kind)).toEqual(["plan", "route.switch", "assistant.message"]);
    expect(turn?.items[1]).toEqual({
      kind: "route.switch",
      from: { harness: "fake", model: "fake-small", effort: "high" },
      to: large,
      reason,
    });
    expect(turn?.usage.map((u) => u.model)).toEqual(["fake-large"]);
  });

  test("a rejected plan and a pinned thread stay on their route", async () => {
    const denied = setup(planned);
    const kept = await denied.run(planTurn(denied.projectPath, { decision: "deny" }));
    expect(kept.request.execute).toBeDefined();
    expect(denied.fake.reroutes).toEqual([]);
    expect(kept.after?.route.model).toBe("fake-small");

    const pinnedThread = setup(planned);
    const onPin = await pinnedThread.run(planTurn(pinnedThread.projectPath, { decision: "allow" }, pinned));
    expect(onPin.request.execute).toBeUndefined();
    expect(pinnedThread.fake.reroutes).toEqual([]);
    expect(onPin.after?.route).toEqual(pinned);
  });
});
