import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, CommandRejected, Route, TaskOutcome, ThreadId, TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { loadThreadView } from "../event-store/projector.ts";
import { Reactor } from "../event-store/reactor.ts";
import { periodsAt } from "./spend.ts";
import { spendCapsFile } from "./spend-caps.ts";

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

/** verdandid on the fake harness, with `caps` as the home's spend-caps.yaml and `routing` as the project's policy. */
const setup = ({ caps, routing }: { caps?: string; routing?: string }) => {
  const home = tempDir();
  const projectPath = tempDir();
  if (caps) writeFileSync(spendCapsFile(home), caps);
  if (routing) {
    mkdirSync(join(projectPath, ".verdandi"));
    writeFileSync(join(projectPath, ".verdandi", "routing.yaml"), routing);
  }
  const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness() }));
  runtimes.push(runtime as never);
  return { projectPath, run: <A, E>(effect: Effect.Effect<A, E, Engine | Reactor | SqlClient.SqlClient>) => runtime.runPromise(effect) };
};

let n = 0;
const id = <T>() => `id-${++n}` as T;
const threadId = "thread-1" as ThreadId;
const pinned: Route = { harness: "fake", model: "fake", effort: "low" };

const dispatch = (c: Command) =>
  Effect.gen(function* () {
    return yield* (yield* Engine).dispatch(c);
  });
/** Sends `text` and waits for its turn to finish; a rejection comes back instead of failing. */
const turn = (text: string) =>
  Effect.gen(function* () {
    const sent = yield* dispatch({
      type: "turn.send",
      commandId: id<CommandId>(),
      threadId,
      turnId: id<TurnId>(),
      text,
      mode: "build",
    }).pipe(
      Effect.map(() => undefined),
      Effect.catchTag("CommandRejected", (e: CommandRejected) => Effect.succeed(e)),
    );
    yield* (yield* Reactor).drain;
    return sent;
  });

describe("spend caps", () => {
  test("metered usage that crosses a cap rejects the next turn; one raise lets it through and is recorded", async () => {
    // "overage" runs on extra usage, priced as metered at $0.01; anything else is subscription usage, which never counts.
    const { projectPath, run } = setup({ caps: "daily: 0.015\n" });
    const { rejected, raised, after } = await run(
      Effect.gen(function* () {
        yield* dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId, projectPath, route: pinned });
        for (const text of ["hi", "hi", "overage", "overage"]) expect(yield* turn(text)).toBeUndefined();
        const rejected = yield* turn("one more");
        yield* dispatch({ type: "spend.cap.raise", commandId: id<CommandId>(), threadId, scope: "profile", period: "day" });
        const after = yield* turn("one more");
        const raised = yield* (yield* SqlClient.SqlClient)<{ payload: string }>`
          select payload from events where type = 'spend.cap.raised'`;
        return { rejected, raised: raised.map((r) => JSON.parse(r.payload)), after };
      }),
    );
    expect(rejected?.reason).toBe("SpendCapReached");
    expect(rejected?.message).toStartWith("The profile's daily cap of metered spend is reached: $0.02 of $0.01 spent today.");
    expect(raised).toEqual([
      expect.objectContaining({ scope: "profile", period: "day", periodKey: periodsAt(new Date()).day.key, fromUsd: 0.015, toUsd: 0.03 }),
    ]);
    expect(after).toBeUndefined();
  });

  test("a task's maxCost ends its turn at the limit, keeps that on its outcome, and the next turn starts a new task", async () => {
    const { projectPath, run } = setup({
      routing: "targets:\n  small: { harness: fake, provider: fake, model: fake-small }\nfallback: { prefer: [small], maxCost: 0.015 }\n",
    });
    const { statuses, outcomes, tasks } = await run(
      Effect.gen(function* () {
        yield* dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId, projectPath });
        // $0.01 a turn: the second turn takes the task to $0.02, over its $0.015.
        for (const text of ["hi", "again", "and again"]) yield* turn(text);
        const sql = yield* SqlClient.SqlClient;
        const outcomes = yield* sql<{ payload: string }>`select payload from task_outcomes order by seq`;
        return {
          statuses: (yield* loadThreadView(threadId))?.turns.map((t) => [t.status, t.error]),
          outcomes: outcomes.map((o) => (JSON.parse(o.payload) as TaskOutcome).status),
          tasks: (yield* sql<{ id: string }>`select id from tasks`).length,
        };
      }),
    );
    expect(statuses).toEqual([
      ["success", undefined],
      ["limit", "Stopped at the task's $0.015 cost limit."],
      ["success", undefined],
    ]);
    expect(tasks).toBe(2);
    expect(outcomes).toEqual(["limit", "completed"]);
  });
});
