import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, TaskId, ThreadId, TurnId } from "@verdandi/contracts";
import { gitHeavyTimeout, makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { loadMemory, loadThreadSummaries, loadThreadView } from "../event-store/projector.ts";
import { Reactor } from "../event-store/reactor.ts";
import { loadUsageReport } from "../spend/usage.ts";
import { allowTrustRequests } from "../trust/allow-trust.ts";
import { loadReviewSettings } from "./review-config.ts";

setDefaultTimeout(gitHeavyTimeout);

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
let n = 0;
const id = <T>() => `id-${++n}` as T;
const threadId = "thread-1" as ThreadId;

/**
 * A verdandid whose home has `review` as its `review.yaml` (none when undefined), and a routed thread in a project
 * whose policy runs tasks on the fake model and background reviews on the small one, and runs `verifiers`, trusted.
 */
const setup = async (review?: string, verifiers?: string[]) => {
  const home = tempDir();
  if (review !== undefined) writeFileSync(join(home, "review.yaml"), review);
  const projectPath = tempDir();
  mkdirSync(join(projectPath, ".verdandi"));
  writeFileSync(
    join(projectPath, ".verdandi", "routing.yaml"),
    [
      "minConfidence: 1",
      "targets:",
      "  small: { harness: fake, provider: fake, model: fake-small }",
      "  mid: { harness: fake, provider: fake, model: fake }",
      "routes:",
      "  aux.review: { prefer: [small], effort: low }",
      "fallback: { prefer: [mid], effort: medium }",
      ...(verifiers ? [`escalation: { verifiers: ${JSON.stringify(verifiers)} }`] : []),
    ].join("\n"),
  );
  const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness() }));
  runtimes.push(runtime as never);
  await runtime.runPromise(allowTrustRequests);
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | Engine | Reactor>) => runtime.runPromise(effect);
  const dispatch = (c: Command) => run(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  await dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId, projectPath });
  const drain = () => run(Effect.flatMap(Reactor, (r) => r.drain));
  return {
    projectPath,
    /** Sends `text` as the thread's next turn and waits until nothing runs: the turn, and any review it sets off. */
    send: async (text: string) => {
      const turnId = id<TurnId>();
      await dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId, text, mode: "build" });
      await drain();
      return turnId;
    },
    /** Rates up the task turn `firstTurn` started, whose id is that turn's. */
    rateUp: (firstTurn: TurnId) =>
      dispatch({ type: "task.rate", commandId: id<CommandId>(), threadId, taskId: firstTurn as string as TaskId, rating: 1 }),
    respond: async (requestId: string) => {
      await dispatch({ type: "approval.respond", commandId: id<CommandId>(), threadId, requestId, resolution: { decision: "allow" } });
      await drain();
    },
    view: () => run(loadThreadView(threadId)),
    threads: () => run(loadThreadSummaries()),
    memory: () => run(loadMemory(threadId)),
    usage: () => run(loadUsageReport({}, new Date())),
    reviewDecisions: () =>
      run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql<{ thread_id: string; answer: string; state: string }>`
            select thread_id, answer, state from decisions where kind = 'task.review-worth' order by seq`,
        ),
      ).then((rows) => rows.map((r) => ({ ...r, answer: JSON.parse(r.answer) as { probability: number } }))),
    reviewTasks: () =>
      run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql<{ thread_id: string; model: string }>`
            select k.thread_id, json_extract(d.payload, '$.target.model') as model
            from route_decisions d join tasks k on k.id = d.task_id where d.task_class = 'aux.review'`,
        ),
      ),
  };
};

test("a task with nothing worth keeping skips the review; one worth it is reviewed on the cheap target, which proposes a memory the user approves", async () => {
  const { send, respond, view, threads, memory, usage, reviewDecisions, reviewTasks } = await setup("enabled: true\n");

  await send("echo the build output");
  // Asked and logged like any decision, with the digest it read; a no costs no model call.
  const [skipped] = await reviewDecisions();
  expect(skipped).toMatchObject({ thread_id: threadId });
  expect(skipped?.answer.probability).toBeLessThan(0.5);
  expect(skipped?.state).toContain("echo the build output");
  expect(await reviewTasks()).toEqual([]);
  expect((await view())?.pendingRequests).toEqual([]);

  await send("remember: the tests need TZ=UTC");
  const decisions = await reviewDecisions();
  expect(decisions).toHaveLength(2);
  expect(decisions[1]?.answer.probability).toBeGreaterThanOrEqual(0.5);
  // Only the turns since the last review are in its digest.
  expect(decisions[1]?.state).not.toContain("echo the build output");

  // The review ran as a task of its own on the policy's cheap target, out of the thread list.
  expect(await reviewTasks()).toMatchObject([{ model: "fake-small" }]);
  expect((await threads()).map((t) => t.threadId)).toEqual([threadId]);
  // Its cost is its own class's, apart from the task it reviewed.
  const byClass = (await usage()).byClass;
  expect(byClass.find((c) => c.taskClass === "aux.review")).toMatchObject({ tasks: 1, cost: { subscriptionUsd: 0.01 } });

  // What it proposes waits for the user on the reviewed thread; nothing is remembered until they allow it.
  const [proposal] = (await view())?.pendingRequests ?? [];
  expect(proposal).toMatchObject({ type: "memory.proposed", threadId, scope: "project", text: "the tests need TZ=UTC" });
  expect((await memory())?.project).toEqual([]);
  await respond(proposal?.requestId ?? "");
  expect((await view())?.pendingRequests).toEqual([]);
  expect((await memory())?.project).toMatchObject([{ text: "the tests need TZ=UTC", source: { threadId } }]);
});

test("a review offers skills only from a task whose last verifier run passed or that the user rated up, and memories from any", async () => {
  const lesson = "skill: tz-tests remember: the tests need TZ=UTC";
  const offered = async (s: Awaited<ReturnType<typeof setup>>) =>
    ((await s.view())?.pendingRequests ?? []).map((r) => (r.type === "skill.proposed" ? r.change.skill : r.type));

  const unchecked = await setup("enabled: true\n");
  await unchecked.send(lesson);
  expect(await offered(unchecked)).toEqual(["memory.proposed"]);

  const verified = await setup("enabled: true\n", ["exit 0"]);
  await verified.send(`edit ${join(verified.projectPath, "a.txt")}`);
  await verified.send(lesson);
  expect(await offered(verified)).toEqual(["memory.proposed", "tz-tests"]);

  const rated = await setup("enabled: true\n");
  await rated.rateUp(await rated.send("hello"));
  await rated.send(lesson);
  expect(await offered(rated)).toEqual(["memory.proposed", "tz-tests"]);
});

test("background review is off without review.yaml: nothing is asked", async () => {
  const { send, reviewDecisions, reviewTasks } = await setup();
  await send("remember: the tests need TZ=UTC");
  expect(await reviewDecisions()).toEqual([]);
  expect(await reviewTasks()).toEqual([]);
});

test("a review that would spend metered dollars runs only when review.yaml allows it", async () => {
  // The fake harness's subscription window is used up and it now pays on extra usage, which is metered.
  const refused = await setup("enabled: true\n");
  await refused.send("overage");
  await refused.send("remember: the tests need TZ=UTC");
  expect((await refused.reviewDecisions()).at(-1)?.answer.probability).toBeGreaterThanOrEqual(0.5);
  expect(await refused.reviewTasks()).toEqual([]);
  expect((await refused.view())?.pendingRequests).toEqual([]);

  const allowed = await setup("enabled: true\nallowMetered: true\n");
  await allowed.send("overage");
  await allowed.send("remember: the tests need TZ=UTC");
  expect(await allowed.reviewTasks()).toMatchObject([{ model: "fake-small" }]);
  expect((await allowed.view())?.pendingRequests).toMatchObject([{ type: "memory.proposed" }]);
});

test("a broken review.yaml fails naming the file and the key", () => {
  const home = tempDir();
  writeFileSync(join(home, "review.yaml"), "enabled: yes please\n");
  expect(() => loadReviewSettings(home)).toThrow(/review\.yaml[\s\S]*enabled/);
});
