import { afterEach, expect, test } from "bun:test";
import {
  type Command,
  type CommandId,
  type TaskId,
  TaskOutcome,
  type TaskRating,
  type ThreadId,
  Trajectory,
  type TurnId,
} from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { loadThreadView } from "../event-store/projector.ts";
import { Reactor } from "../event-store/reactor.ts";
import { loadTaskCosts } from "./task-outcome.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) removeTempHome(h);
});
const newHome = () => {
  const home = makeTempHome();
  homes.push(home);
  return home;
};

const route = { harness: "fake", model: "fake", effort: "low" } as const;
const drain = Effect.flatMap(Reactor, (reactor) => reactor.drain);

/** Runs `effect` against a verdandid on `home`, once its startup work has finished. */
const withApp = <A, E>(home: string, effect: Effect.Effect<A, E, Engine | Reactor | SqlClient.SqlClient>) => {
  const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness() }));
  return runtime.runPromise(Effect.andThen(drain, effect)).finally(() => runtime.dispose());
};

const dispatch = (c: Command) => Effect.flatMap(Engine, (engine) => engine.dispatch(c)).pipe(Effect.andThen(drain));
const uuid = <T>() => crypto.randomUUID() as T;
const create = (threadId: ThreadId) => dispatch({ type: "thread.create", commandId: uuid(), threadId, projectPath: "/repo", route });
const runTurn = (threadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const turnId = uuid<TurnId>();
    yield* dispatch({ type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId, text, mode: "build" });
    return turnId;
  });
const outcomes = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ thread_id: string; payload: string }>`
    select k.thread_id, o.payload from task_outcomes o join tasks k on k.id = o.task_id order by k.seq`,
).pipe(Effect.map((rows) => rows.map((r) => Schema.decodeUnknownSync(Schema.fromJsonString(TaskOutcome))(r.payload))));
const trajectoryTasks = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ turn_id: string; payload: string }>`select turn_id, payload from trajectories`,
).pipe(
  Effect.map((rows) =>
    Object.fromEntries(rows.map((r) => [r.turn_id, Schema.decodeUnknownSync(Schema.fromJsonString(Trajectory))(r.payload).taskId])),
  ),
);

test("a route change starts a second task; both get outcomes, and cost per completed task counts failures by route", async () => {
  const [one, two] = [uuid<ThreadId>(), uuid<ThreadId>()];
  const result = await withApp(
    newHome(),
    Effect.gen(function* () {
      yield* create(one);
      const first = yield* runTurn(one, "hi");
      yield* dispatch({ type: "thread.route.set", commandId: uuid(), threadId: one, route: { ...route, model: "fake-2" } });
      const overridden = yield* outcomes; // recorded on the route change, before another turn runs
      const second = yield* runTurn(one, "hi");
      const third = yield* runTurn(one, "fail");
      yield* create(two);
      yield* runTurn(two, "hi");
      return {
        first,
        second,
        third,
        overridden,
        outcomes: yield* outcomes,
        trajectories: yield* trajectoryTasks,
        costs: yield* loadTaskCosts,
      };
    }),
  );
  const { first, second, third } = result;
  expect(result.overridden[0]?.userOverride).toEqual({ from: route, to: { ...route, model: "fake-2" } });

  const [task1, task2, task3] = result.outcomes;
  expect(task1).toMatchObject({ taskId: first, threadId: one, route, status: "completed", turns: 1, implicitSatisfaction: 0 });
  expect(task2).toMatchObject({ taskId: second, threadId: one, route: { ...route, model: "fake-2" }, status: "failed", turns: 2 });
  expect(task2?.usage).toMatchObject([{ model: "fake-2", costUsd: 0.01 }]);
  expect(task3).toMatchObject({ threadId: two, status: "completed", implicitSatisfaction: 1 });
  expect(result.trajectories).toMatchObject({ [first]: first, [second]: second, [third]: second });

  expect(result.costs).toEqual([
    { route, tasks: 2, completed: 2, costUsd: 0.02, costPerCompletedUsd: 0.01 },
    { route: { ...route, model: "fake-2" }, tasks: 1, completed: 0, costUsd: 0.01, costPerCompletedUsd: null },
  ]);
});

test("task outcomes verdandid missed are recorded when it next starts", async () => {
  const home = newHome();
  const threadId = uuid<ThreadId>();
  await withApp(
    home,
    Effect.gen(function* () {
      yield* create(threadId);
      yield* runTurn(threadId, "hi");
      yield* Effect.flatMap(SqlClient.SqlClient, (sql) => sql`delete from task_outcomes`); // as if verdandid died before writing it
    }),
  );
  const rows = await withApp(home, outcomes);
  expect(rows.map((o) => [o.threadId, o.status])).toEqual([[threadId, "completed"]]);
});

test("a rating reaches its task's outcome, an earlier task's too, and clearing it removes it", async () => {
  const [threadId, other] = [uuid<ThreadId>(), uuid<ThreadId>()];
  const rate = (turnId: TurnId, rating: TaskRating | null, thread = threadId) =>
    dispatch({ type: "task.rate", commandId: uuid(), threadId: thread, taskId: turnId as string as TaskId, rating });
  const ratings = Effect.map(outcomes, (rows) => rows.map((o) => o.rating));
  const result = await withApp(
    newHome(),
    Effect.gen(function* () {
      yield* create(threadId);
      const first = yield* runTurn(threadId, "hi");
      yield* rate(first, -1);
      const down = yield* ratings;
      yield* dispatch({ type: "thread.route.set", commandId: uuid(), threadId, route: { ...route, model: "fake-2" } });
      yield* runTurn(threadId, "hi");
      yield* rate(first, 1);
      const up = yield* ratings;
      const tasks = (yield* loadThreadView(threadId))?.tasks;
      yield* rate(first, null);
      const cleared = yield* ratings;
      yield* create(other);
      const foreign = yield* Effect.flip(rate(first, 1, other));
      return { first, down, up, tasks, cleared, foreign };
    }),
  );
  expect(result.down).toEqual([-1]);
  expect(result.up).toEqual([1, undefined]);
  expect(result.tasks?.map((t) => t.rating)).toEqual([1, null]);
  expect(result.tasks?.[0]?.taskId).toBe(result.first as string as TaskId);
  expect(result.cleared).toEqual([undefined, undefined]);
  expect(result.foreign.reason).toBe("TaskNotFound");
});
