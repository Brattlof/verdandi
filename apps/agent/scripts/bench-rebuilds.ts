// Times the two read paths that rebuild from scratch (#140): a turn end's task-outcome rebuild on a long
// thread, and a routed turn.send's routing-memory load in a project with many tasks.
//   bun apps/agent/scripts/bench-rebuilds.ts [--turns 1000] [--tasks 5000] [--runs 30]
// Everything runs in-process on a temporary home and project folder, removed at the end; never ~/.verdandi.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Command, type CommandId, TaskClass, type TaskId, type TaskOutcome, type ThreadId, type TurnId } from "@verdandi/contracts";
import { makeFakeHarness } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../src/event-store/app.ts";
import { Engine } from "../src/event-store/engine.ts";
import { Reactor } from "../src/event-store/reactor.ts";
import { loadRoutingMemory } from "../src/routing/routing-memory.ts";
import { recordTaskOutcomes } from "../src/tasks/task-outcome.ts";

const { values } = parseArgs({ options: { turns: { type: "string" }, tasks: { type: "string" }, runs: { type: "string" } } });
const turns = Number(values.turns ?? 1000);
const tasks = Number(values.tasks ?? 5000);
const runs = Number(values.runs ?? 30);

const home = mkdtempSync(join(tmpdir(), "verdandi-bench-home-"));
const project = mkdtempSync(join(tmpdir(), "verdandi-bench-project-"));
mkdirSync(join(project, ".verdandi"));
// Every routed task goes to the fake harness, the only one running.
writeFileSync(
  join(project, ".verdandi", "routing.yaml"),
  [
    "minConfidence: 1",
    "targets:",
    "  mid: { harness: fake, provider: fake, model: fake }",
    "fallback: { prefer: [mid], effort: medium }",
  ].join("\n"),
);
const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness() }));
const run = <A, E>(effect: Effect.Effect<A, E, Engine | Reactor | SqlClient.SqlClient>) => runtime.runPromise(effect);
const uuid = <T>() => crypto.randomUUID() as T;
const dispatch = (c: Command) => run(Effect.flatMap(Engine, (e) => e.dispatch(c)));
const drain = () => run(Effect.flatMap(Reactor, (r) => r.drain));
const send = (threadId: ThreadId, text: string) =>
  dispatch({ type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId: uuid<TurnId>(), text, mode: "build" });

const time = async (fn: () => Promise<unknown>) => {
  const start = performance.now();
  await fn();
  return performance.now() - start;
};
const report = (label: string, ms: number[]) => {
  const sorted = ms.toSorted((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]?.toFixed(2);
  console.log(`${label}: median ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${at(1)} ms (${ms.length} runs)`);
};

try {
  await drain();
  const cpu = cpus()[0]?.model ?? "unknown CPU";
  console.log(
    `${cpu}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB, ${platform()} ${release()} ${arch()}, Bun ${Bun.version}`,
  );

  // (a) One pinned thread of `turns` real fake-harness turns, all one task: the rebuild reads all of that task's events.
  // "subagent" turns report a few tool calls each, closer to a coding agent's turn than an echo.
  const long = uuid<ThreadId>();
  const pin = { harness: "fake", model: "fake", effort: "low" } as const;
  await dispatch({ type: "thread.create", commandId: uuid(), threadId: long, projectPath: project, route: pin });
  let seeded = performance.now();
  for (let i = 0; i < turns; i++) {
    await send(long, "subagent");
    await drain();
  }
  const [events] = await run(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ n: number }>`select count(*) as n from events where thread_id = ${long}`),
  );
  console.log(`seeded a ${turns}-turn thread (${events?.n} events) in ${((performance.now() - seeded) / 1000).toFixed(1)} s`);
  const rebuild = async () => {
    const ms = [];
    for (let i = 0; i < runs; i++) ms.push(await time(() => run(recordTaskOutcomes(long))));
    return ms;
  };
  report(`(a) turn end's outcome rebuild, ${turns}-turn thread, one task`, await rebuild());
  // The same thread once a route change has started a second task, one turn long.
  await dispatch({ type: "thread.route.set", commandId: uuid(), threadId: long, route: { ...pin, model: "fake-2" } });
  await send(long, "subagent");
  await drain();
  report(`(a) turn end's outcome rebuild, ${turns + 1}-turn thread, current task 1 turn`, await rebuild());

  // (b) A project of `tasks` tasks: one real routed task, whose task, decision and outcome rows (all routing memory
  // reads) are copied to the rest across task classes, routes, overrides and ratings; plus the long thread's two tasks.
  seeded = performance.now();
  const routed = uuid<ThreadId>();
  await dispatch({ type: "thread.create", commandId: uuid(), threadId: routed, projectPath: project });
  await send(routed, "hi");
  await drain();
  await run(
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const [task] = yield* sql<{ id: TaskId; route: string; seq: number; started_at: string; payload: string; decision: string }>`
            select k.id, k.route, k.seq, k.started_at, o.payload, d.payload as decision from tasks k
              join task_outcomes o on o.task_id = k.id join route_decisions d on d.task_id = k.id
            where k.thread_id = ${routed}`;
          if (!task) throw new Error("The routed turn left no outcome: check the project's routing.yaml.");
          const outcome = JSON.parse(task.payload) as TaskOutcome;
          const classes = TaskClass.literals;
          const efforts = ["low", "medium", "high"] as const;
          for (let i = 1; i <= tasks - 3; i++) {
            const taskId = `${task.id}-${i}` as TaskId;
            const taskClass = classes[i % classes.length] ?? "chat.general";
            const copy: TaskOutcome = {
              ...outcome,
              taskId,
              route: { harness: "fake", model: `fake-${i % 8}`, effort: efforts[i % efforts.length] ?? "low" },
              ...(i % 7 === 0
                ? { userOverride: { from: outcome.route, to: { harness: "fake", model: "fake-large", effort: "high" } } }
                : {}),
              ...(i % 5 === 0 ? { rating: -1 } : {}),
            };
            yield* sql`insert into tasks (id, thread_id, route, seq, started_at) values (${taskId}, ${routed}, ${task.route}, ${task.seq}, ${task.started_at})`;
            yield* sql`insert into route_decisions (task_id, source, task_class, reason, payload, decided_at)
              values (${taskId}, 'policy', ${taskClass}, 'bench', ${task.decision}, ${task.started_at})`;
            yield* sql`insert into task_outcomes (task_id, status, cost_usd, payload, seq, recorded_at)
              values (${taskId}, ${copy.status}, 0, ${JSON.stringify(copy)}, ${task.seq}, ${task.started_at})`;
          }
        }),
      ),
    ),
  );
  const [count] = await run(Effect.flatMap(SqlClient.SqlClient, (sql) => sql<{ n: number }>`select count(*) as n from task_outcomes`));
  console.log(`seeded a ${count?.n}-task project in ${((performance.now() - seeded) / 1000).toFixed(1)} s`);
  const memory = [];
  const sends = [];
  for (let i = 0; i < runs; i++) {
    memory.push(await time(() => run(loadRoutingMemory(routed))));
    // A new unpinned thread's first turn starts a task, so the engine routes it and loads routing memory.
    const fresh = uuid<ThreadId>();
    await dispatch({ type: "thread.create", commandId: uuid(), threadId: fresh, projectPath: project });
    sends.push(await time(() => send(fresh, "hi")));
    await drain();
  }
  report(`(b) routing-memory load, ${count?.n}-task project`, memory);
  report(`(b) routed turn.send dispatch, ${count?.n}-task project`, sends);
} finally {
  await runtime.dispose();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
