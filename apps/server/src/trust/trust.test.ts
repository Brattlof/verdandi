import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, Event, Item, TaskOutcome, ThreadId, TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, makeTempRepo, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { loadThreadView } from "../event-store/projector.ts";
import { Reactor } from "../event-store/reactor.ts";
import { listTrusted } from "./trust.ts";

const dirs: string[] = [];
const runtimes: ManagedRuntime.ManagedRuntime<unknown, unknown>[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const d of dirs.splice(0)) removeTempHome(d);
});

let n = 0;
const id = <T>() => `id-${++n}` as T;
const threadId = "thread-1" as ThreadId;
type TrustRequested = Extract<Event, { type: "commands.trust.requested" }>;

/**
 * A project whose `.verdandi/` holds `files`, a git repo if asked, and a pinned thread on the fake harness in it (in a
 * worktree if asked). `asked()` resolves with the next trust request once it commits, so a test waits on it, not a clock.
 */
const setup = async (files: Record<string, string>, { git = false, worktree = false } = {}) => {
  const projectPath = git ? makeTempRepo({ "a.txt": "one\n" }) : makeTempHome();
  const home = makeTempHome();
  dirs.push(projectPath, home);
  mkdirSync(join(projectPath, ".verdandi"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(projectPath, ".verdandi", name), text);
  const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness() }));
  runtimes.push(runtime as never);
  let next = Promise.withResolvers<TrustRequested>();
  await runtime.runPromise(
    Effect.flatMap(Engine, (engine) =>
      engine.react(({ event: e }) => Effect.sync(() => e.type === "commands.trust.requested" && next.resolve(e))),
    ),
  );
  const asked = async () => {
    const request = await next.promise;
    next = Promise.withResolvers();
    return request;
  };
  const dispatch = (c: Command) => runtime.runPromise(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  const drain = () => runtime.runPromise(Effect.flatMap(Reactor, (r) => r.drain));
  const send = (text: string) =>
    dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId: id<TurnId>(), text, mode: "build" });
  const answer = (r: TrustRequested, decision: "allow" | "deny") =>
    dispatch({ type: "approval.respond", commandId: id<CommandId>(), threadId, requestId: r.requestId, resolution: { decision } });
  const read = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const view = yield* loadThreadView(threadId);
        const [row] = yield* (yield* SqlClient.SqlClient)<{ payload: string }>`select payload from task_outcomes`;
        return { view, turn: view?.turns.at(-1), outcome: row && (JSON.parse(row.payload) as TaskOutcome), trusted: yield* listTrusted() };
      }),
    );
  await dispatch({
    type: "thread.create",
    commandId: id<CommandId>(),
    threadId,
    projectPath,
    route: { harness: "fake", model: "fake", effort: "low" },
    ...(worktree && { worktree }),
  });
  return { projectPath, send, asked, answer, drain, read, dispatch };
};

const verifiers = (items: readonly Item[] | undefined) =>
  (items ?? []).flatMap((i) => (i.kind === "verifier" ? [`${i.command}: ${i.passed ? "passed" : "failed"}`] : []));

test("a project's verifiers run only once the user trusts them, and then without asking until revoked", async () => {
  const { send, asked, answer, drain, read, dispatch } = await setup({ "routing.yaml": 'escalation: { verifiers: ["echo checked"] }' });
  await send("edit a.txt");
  const request = await asked();
  expect(request).toMatchObject({ purpose: "verifiers", commands: ["echo checked"] });
  const waiting = await read();
  expect(waiting.turn?.status).toBe("running");
  expect(verifiers(waiting.turn?.items)).toEqual([]);
  expect(waiting.view?.pendingRequests).toMatchObject([{ type: "commands.trust.requested", commands: ["echo checked"] }]);

  await answer(request, "allow");
  await drain();
  expect(verifiers((await read()).turn?.items)).toEqual(["echo checked: passed"]);

  // Trusted now: the next turn runs them without asking.
  await send("edit a.txt");
  await drain();
  const trusted = await read();
  expect(verifiers(trusted.turn?.items)).toEqual(["echo checked: passed"]);
  expect(trusted.trusted).toMatchObject([{ purpose: "verifiers", commands: ["echo checked"], threadId }]);

  // Revoked, they wait for the user again.
  await dispatch({ type: "commands.trust.revoke", commandId: id<CommandId>(), threadId, hash: request.hash });
  expect((await read()).trusted).toEqual([]);
  await send("edit a.txt");
  expect(await asked()).toMatchObject({ commands: ["echo checked"] });
});

test("a turn that rewrites the project's verifiers asks again before they run, and denying it runs nothing", async () => {
  const { send, asked, answer, drain, read } = await setup(
    { "routing.yaml": 'escalation: { verifiers: ["echo checked"] }' },
    { git: true },
  );
  await send("edit a.txt");
  await answer(await asked(), "allow");
  await drain();

  // The agent changes the list through the shell, with no file tool, so only the checkpoints see it (#171).
  await send('write .verdandi/routing.yaml escalation: { verifiers: ["echo pwned"] }');
  const request = await asked();
  expect(request).toMatchObject({ purpose: "verifiers", commands: ["echo pwned"] });
  expect(verifiers((await read()).turn?.items)).toEqual([]);

  await answer(request, "deny");
  await drain();
  const { turn, outcome } = await read();
  expect(turn?.status).toBe("success");
  expect(verifiers(turn?.items)).toEqual([]);
  expect(turn?.items).toContainEqual({
    kind: "notice",
    text: "Verdandi didn't run this project's verifiers (`echo pwned` from .verdandi/routing.yaml): they weren't allowed to run. The task records no verifier run, and the next turn that changes files asks again.",
  });
  // The task keeps its first turn's run and records none for this one.
  expect(outcome).toMatchObject({ status: "completed", verifierRuns: [{ command: "echo checked", passed: true }] });
});

test("a worktree's setup waits for trust, and the thread's next turn asks before the agent starts", async () => {
  const { send, asked, answer, drain, read } = await setup({ "worktree.yaml": "setup: echo set up" }, { git: true, worktree: true });
  await drain();
  const added = (await read()).view?.worktree;
  expect(added).toMatchObject({ state: "ready", held: "echo set up" });
  expect(added?.setup).toBeUndefined();

  await send("hello");
  const request = await asked();
  expect(request).toMatchObject({ purpose: "setup", commands: ["echo set up"] });
  await answer(request, "allow");
  await drain();
  const { view, turn } = await read();
  expect(view?.worktree).toMatchObject({ setup: { command: "echo set up", passed: true } });
  expect(view?.worktree?.held).toBeUndefined();
  expect(turn).toMatchObject({ status: "success", items: [{ kind: "assistant.message", text: "echo: hello" }] });
});
