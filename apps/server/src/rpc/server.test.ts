import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { CommandId, ProjectsFeed, TaskId, ThreadFeed, ThreadId, TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, makeTempRepo, removeTempHome } from "@verdandi/testkit";
import { Deferred, Effect, Fiber, ManagedRuntime, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { spendCapsFile } from "../config/spend-caps.ts";
import { Reactor } from "../orchestration/reactor.ts";
import { connect } from "./client.ts";
import { ServerInfo, ServerLayer } from "./server.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
/** A project folder that isn't a git repo. */
const folder = makeTempHome();
afterAll(() => removeTempHome(folder));

const route = { harness: "fake", model: "fake", effort: "low" } as const;
const uuid = <T>() => crypto.randomUUID() as T;

const startServer = async () => {
  const home = makeTempHome();
  const fake = makeFakeHarness();
  const runtime = ManagedRuntime.make(ServerLayer(home, { fake }));
  cleanups.push(async () => removeTempHome(home));
  cleanups.push(() => runtime.dispose());
  const info = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ServerInfo;
    }),
  );
  const drain = () =>
    runtime.runPromise(
      Effect.gen(function* () {
        yield* (yield* Reactor).drain;
      }),
    );
  return { info, fake, drain, home, runtime };
};

/** Runs `f` with a connected client in its own scope; the socket closes when `f` returns. */
const withClient = <A, E>(port: number, token: string, f: (client: Effect.Success<ReturnType<typeof connect>>) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(connect({ port, token }), f)));

/** Fails with the step's name instead of hanging until the test timeout, so a CI hang says where it stuck. */
const step = <A, E>(label: string, e: Effect.Effect<A, E>) =>
  e.pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.die(`step timed out: ${label}`) }));

const createThread = (client: Effect.Success<ReturnType<typeof connect>>, threadId: ThreadId) =>
  client.CommandDispatch({ type: "thread.create", commandId: uuid<CommandId>(), threadId, projectPath: folder, route });

describe("rpc server", () => {
  test("shuts down while a client is still connected", async () => {
    const home = makeTempHome();
    cleanups.push(async () => removeTempHome(home));
    const runtime = ManagedRuntime.make(ServerLayer(home, { fake: makeFakeHarness() }));
    const info = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* ServerInfo;
      }),
    );
    const connected = Promise.withResolvers<void>();
    const client = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const c = yield* connect(info);
          yield* createThread(c, uuid<ThreadId>());
          connected.resolve();
          yield* Effect.never; // stays connected, like an open `verdandi chat`
        }),
      ),
    );
    cleanups.push(() => Effect.runPromise(Fiber.interrupt(client)).then(() => undefined));
    await connected.promise;
    await runtime.dispose(); // must not wait for the client to leave
  });

  test("serves the web UI and its bundle without the token", async () => {
    const { info } = await startServer();
    const page = await fetch(`http://127.0.0.1:${info.port}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).not.toContain(info.token);
    const script = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
    expect(script).toBeDefined();
    const bundle = await fetch(new URL(script ?? "", `http://127.0.0.1:${info.port}/`));
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toContain("javascript");
    const stylesheet = html.match(/<link[^>]+href="([^"]+\.css)"/)?.[1];
    const css = await (await fetch(new URL(stylesheet ?? "", `http://127.0.0.1:${info.port}/`))).text();
    expect(css).not.toContain("@tailwind"); // Tailwind ran, rather than Bun inlining its source
  });

  test("rejects a connection without the right token", async () => {
    const { info } = await startServer();
    const wrong = await Effect.runPromise(
      Effect.exit(
        Effect.scoped(
          Effect.flatMap(connect({ port: info.port, token: "wrong" }), (c) => createThread(c, uuid<ThreadId>())).pipe(
            Effect.timeout("5 seconds"),
          ),
        ),
      ),
    );
    expect(wrong._tag).toBe("Failure");
    const right = await withClient(info.port, info.token, (c) => createThread(c, uuid<ThreadId>()));
    expect(right.seq).toBeGreaterThan(0);
  });

  test("subscribe returns a snapshot, then events and deltas; unsubscribe ends it", async () => {
    const { info } = await startServer();
    const threadId = uuid<ThreadId>();
    const [kinds, after] = await withClient(info.port, info.token, (c) =>
      Effect.gen(function* () {
        yield* step("create", createThread(c, threadId));
        const subscriptionId = crypto.randomUUID();
        const seen: string[] = [];
        const snapshot = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        // The consumer only records; the send and the unsubscribe happen outside it, as the CLI does.
        const feed = yield* c.ThreadSubscribe({ threadId, subscriptionId }).pipe(
          Stream.runForEach((f: ThreadFeed) => {
            seen.push(f.kind === "event" ? f.stored.event.type : f.kind);
            if (f.kind === "snapshot") return Deferred.succeed(snapshot, undefined);
            if (f.kind === "event" && f.stored.event.type === "turn.completed") return Deferred.succeed(completed, undefined);
            return Effect.void;
          }),
          Effect.forkChild,
        );
        yield* step("snapshot", Deferred.await(snapshot));
        yield* step(
          "send",
          c.CommandDispatch({
            type: "turn.send",
            commandId: uuid<CommandId>(),
            threadId,
            turnId: uuid<TurnId>(),
            text: "hi",
            mode: "build",
          }),
        );
        yield* step("turn.completed", Deferred.await(completed));
        yield* step("unsubscribe", c.Unsubscribe({ subscriptionId }));
        yield* step("feed end", Fiber.join(feed));
        const after = yield* step("create after", createThread(c, uuid<ThreadId>()));
        return [seen, after] as const;
      }),
    );
    expect(kinds[0]).toBe("snapshot");
    expect(kinds).toContain("turn.started");
    expect(kinds).toContain("delta");
    expect(kinds.at(-1)).toBe("turn.completed");
    expect(after.seq).toBeGreaterThan(0); // the connection still answers after the feed ended (ADR 0008)
  });

  test("projects feed shows a new thread and its busy/idle changes without polling", async () => {
    const { info, fake } = await startServer();
    const before = uuid<ThreadId>();
    const threadId = uuid<ThreadId>();
    const [snapshot, changes] = await withClient(info.port, info.token, (c) =>
      Effect.gen(function* () {
        yield* step("create before", createThread(c, before));
        const subscriptionId = crypto.randomUUID();
        const changes: Extract<ProjectsFeed, { kind: "thread" }>[] = [];
        const snapshot = yield* Deferred.make<Extract<ProjectsFeed, { kind: "snapshot" }>>();
        const idle = yield* Deferred.make<void>();
        // The consumer only records; commands and the unsubscribe happen outside it (ADR 0008).
        const feed = yield* c.ProjectsSubscribe({ subscriptionId }).pipe(
          Stream.runForEach((f: ProjectsFeed) => {
            if (f.kind === "snapshot") return Deferred.succeed(snapshot, f);
            if (f.kind !== "thread") return Effect.void;
            changes.push(f);
            return changes.some((x) => x.thread.busy) && !f.thread.busy ? Deferred.succeed(idle, undefined) : Effect.void;
          }),
          Effect.forkChild,
        );
        const first = yield* step("snapshot", Deferred.await(snapshot));
        yield* step("create", createThread(c, threadId));
        const turn = { type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId: uuid<TurnId>(), mode: "build" } as const;
        yield* step("send", c.CommandDispatch({ ...turn, text: "gate\nsecond line" }));
        fake.release();
        yield* step("idle", Deferred.await(idle));
        yield* step("unsubscribe", c.Unsubscribe({ subscriptionId }));
        yield* step("feed end", Fiber.join(feed));
        return [first, changes] as const;
      }),
    );
    expect(snapshot.threads.map((t) => t.threadId)).toEqual([before]);
    expect(snapshot.projects.map((p) => p.path)).toEqual([realpathSync.native(folder)]);
    expect(changes.map((c) => [c.thread.threadId, c.thread.busy, c.thread.title])).toEqual([
      [threadId, false, ""],
      [threadId, true, "gate"],
      [threadId, false, "gate"],
    ]);
    expect(changes[0]?.project?.path).toBe(realpathSync.native(folder));
    expect(changes[1]?.project).toBeUndefined();
    expect(changes.map((c) => c.seq)).toEqual(changes.map((c) => c.seq).sort((a, b) => a - b));
    expect(changes.at(-1)?.thread.cost).toEqual({ meteredUsd: 0, subscriptionUsd: 0.01 });
  });

  test("a reported quota and the thread's metered cost reach the feed live and after a reload", async () => {
    const { info } = await startServer();
    const threadId = uuid<ThreadId>();
    /** Subscribes, runs `during`, and collects feed messages until `done` says so. */
    const watch = (
      c: Effect.Success<ReturnType<typeof connect>>,
      during: Effect.Effect<unknown, unknown>,
      done: (f: ProjectsFeed) => boolean,
    ) =>
      Effect.gen(function* () {
        const subscriptionId = crypto.randomUUID();
        const seen: ProjectsFeed[] = [];
        const finished = yield* Deferred.make<void>();
        const feed = yield* c.ProjectsSubscribe({ subscriptionId }).pipe(
          Stream.runForEach((f: ProjectsFeed) => {
            seen.push(f);
            return done(f) ? Deferred.succeed(finished, undefined) : Effect.void;
          }),
          Effect.forkChild,
        );
        yield* step("during", during);
        yield* step("done", Deferred.await(finished));
        yield* step("unsubscribe", c.Unsubscribe({ subscriptionId }));
        yield* step("feed end", Fiber.join(feed));
        return seen;
      });
    const [live, reloaded] = await withClient(info.port, info.token, (c) =>
      Effect.gen(function* () {
        const send = { type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId: uuid<TurnId>(), mode: "build" } as const;
        const run = Effect.andThen(createThread(c, threadId), c.CommandDispatch({ ...send, text: "overage" }));
        const live = yield* watch(c, run, (f) => f.kind === "thread" && f.thread.cost.meteredUsd > 0);
        const reloaded = yield* watch(c, Effect.void, (f) => f.kind === "snapshot");
        return [live, reloaded] as const;
      }),
    );
    const quota = {
      status: "rejected",
      window: "five_hour",
      utilization: 1,
      resetsAt: "2026-10-01T00:00:00.000Z",
      usingOverage: true,
    } as const;
    expect(live.flatMap((f) => (f.kind === "quota" ? [f.quota.quota] : []))).toEqual([quota]);
    const [snapshot] = reloaded;
    expect(snapshot?.kind === "snapshot" && snapshot.quotas.map((q) => [q.harness, q.quota])).toEqual([["fake", quota]]);
    expect(snapshot?.kind === "snapshot" && snapshot.threads.map((t) => t.cost)).toEqual([{ meteredUsd: 0.01, subscriptionUsd: 0 }]);
  });

  test("turn survives client disconnect", async () => {
    const { info, fake, drain } = await startServer();
    const threadId = uuid<ThreadId>();
    await withClient(info.port, info.token, (c) =>
      Effect.gen(function* () {
        yield* step("create", createThread(c, threadId));
        yield* step(
          "send",
          c.CommandDispatch({
            type: "turn.send",
            commandId: uuid<CommandId>(),
            threadId,
            turnId: uuid<TurnId>(),
            text: "gate",
            mode: "build",
          }),
        );
      }),
    );
    fake.release();
    await drain();
    const statuses = await withClient(info.port, info.token, (c) =>
      Effect.gen(function* () {
        const subscriptionId = crypto.randomUUID();
        const snapshot = yield* Deferred.make<string[]>();
        // The consumer only records; the unsubscribe happens outside it, as the CLI does.
        const feed = yield* c.ThreadSubscribe({ threadId, subscriptionId }).pipe(
          Stream.runForEach((f: ThreadFeed) =>
            f.kind === "snapshot"
              ? Deferred.succeed(
                  snapshot,
                  f.thread.turns.map((t) => t.status),
                )
              : Effect.void,
          ),
          Effect.forkChild,
        );
        const statuses = yield* step("snapshot", Deferred.await(snapshot));
        yield* step("unsubscribe", c.Unsubscribe({ subscriptionId }));
        yield* step("feed end", Fiber.join(feed));
        return statuses;
      }),
    );
    expect(statuses).toEqual(["success"]);
  });

  test("concurrent sends yield one ThreadBusy", async () => {
    const { info, fake } = await startServer();
    const threadId = uuid<ThreadId>();
    await withClient(info.port, info.token, (c) => createThread(c, threadId));
    const send = () =>
      withClient(info.port, info.token, (c) =>
        Effect.exit(
          c.CommandDispatch({
            type: "turn.send",
            commandId: uuid<CommandId>(),
            threadId,
            turnId: uuid<TurnId>(),
            text: "gate",
            mode: "build",
          }),
        ),
      );
    const results = await Promise.all([send(), send()]);
    fake.release();
    const outcomes = results
      .map((r) => (r._tag === "Success" ? "ok" : JSON.stringify(r.cause).includes("ThreadBusy") ? "busy" : "other"))
      .sort();
    expect(outcomes).toEqual(["busy", "ok"]);
  });

  test("DiffGet shows exactly what a turn edited, and the whole project without a turn", async () => {
    const { info, drain } = await startServer();
    const repo = makeTempRepo({ "a b.txt": "one\r\ntwo\r\n", "mine.txt": "mine\n" });
    cleanups.push(async () => removeTempHome(repo));
    appendFileSync(join(repo, "mine.txt"), "the user's own edit\n");
    const threadId = uuid<ThreadId>();
    const turnId = uuid<TurnId>();
    await withClient(info.port, info.token, (c) =>
      Effect.gen(function* () {
        yield* c.CommandDispatch({ type: "thread.create", commandId: uuid<CommandId>(), threadId, projectPath: repo, route });
        const text = `edit ${join(repo, "a b.txt")}`;
        yield* c.CommandDispatch({ type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId, text, mode: "build" });
      }),
    );
    await drain();
    const [turn, all, missing] = await withClient(info.port, info.token, (c) =>
      Effect.all([c.DiffGet({ threadId, turnId }), c.DiffGet({ threadId }), Effect.flip(c.DiffGet({ threadId, turnId: uuid<TurnId>() }))]),
    );
    const changed = (diff: string) => diff.split("\n").filter((l) => /^[+-](?![+-]{2} )/.test(l));
    expect(turn.files.map((f) => [f.path, changed(f.diff)])).toEqual([["a b.txt", ["+edited by the fake harness"]]]);
    expect(all.files.map((f) => f.path)).toEqual(["a b.txt", "mine.txt"]);
    expect(missing.reason).toBe("TurnNotFound");
  });

  test("DiffGet names the fix when the project isn't a git repo", async () => {
    const { info } = await startServer();
    const threadId = uuid<ThreadId>();
    const error = await withClient(info.port, info.token, (c) =>
      Effect.gen(function* () {
        yield* createThread(c, threadId);
        return yield* Effect.flip(c.DiffGet({ threadId }));
      }),
    );
    expect(error.reason).toBe("NotAGitRepo");
    expect(error.message).toContain("git init");
  });

  test("TaskCostsList reports cost per completed task by route", async () => {
    const { info, drain } = await startServer();
    const threadId = uuid<ThreadId>();
    const turn = { type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId: uuid<TurnId>(), text: "hi", mode: "build" } as const;
    await withClient(info.port, info.token, (c) => Effect.andThen(createThread(c, threadId), c.CommandDispatch(turn)));
    await drain();
    const costs = await withClient(info.port, info.token, (c) => c.TaskCostsList());
    expect(costs).toEqual([{ route, tasks: 1, completed: 1, costUsd: 0.01, costPerCompletedUsd: 0.01 }]);
  });

  test("SpendCapsGet shows how close the thread's caps are, and after a raise the limit in force", async () => {
    const { info, drain, home } = await startServer();
    writeFileSync(spendCapsFile(home), "daily: 0.005\nmonthly: 10\n");
    const threadId = uuid<ThreadId>();
    const turn = {
      type: "turn.send",
      commandId: uuid<CommandId>(),
      threadId,
      turnId: uuid<TurnId>(),
      text: "overage",
      mode: "build",
    } as const;
    await withClient(info.port, info.token, (c) => Effect.andThen(createThread(c, threadId), c.CommandDispatch(turn)));
    await drain();
    const { before, after } = await withClient(info.port, info.token, (c) =>
      Effect.gen(function* () {
        const before = yield* c.SpendCapsGet({ threadId });
        yield* c.CommandDispatch({ type: "spend.cap.raise", commandId: uuid<CommandId>(), threadId, scope: "profile", period: "day" });
        return { before, after: yield* c.SpendCapsGet({ threadId }) };
      }),
    );
    expect(before.map((c) => [c.period, c.limitUsd, c.spentUsd])).toEqual([
      ["day", 0.005, 0.01],
      ["month", 10, 0.01],
    ]);
    expect(after[0]).toMatchObject({ period: "day", baseUsd: 0.005, limitUsd: 0.01 });
  });

  test("RoutingSimulate previews a draft without storing it, and RoutingExplain returns a task's decision", async () => {
    const { info, drain } = await startServer();
    const project = makeTempHome();
    cleanups.push(async () => removeTempHome(project));
    mkdirSync(join(project, ".verdandi"));
    writeFileSync(
      join(project, ".verdandi", "routing.yaml"),
      "targets:\n  small: { harness: fake, provider: fake, model: fake-small }\nroutes:\n  ask.search: { prefer: [small], effort: low }\n",
    );
    const threadId = uuid<ThreadId>();
    const turnId = uuid<TurnId>();
    const text = "Where is the auth middleware?";
    const { preview, before, decision, missing } = await withClient(info.port, info.token, (c) =>
      Effect.gen(function* () {
        yield* c.CommandDispatch({ type: "thread.create", commandId: uuid<CommandId>(), threadId, projectPath: project });
        const preview = yield* c.RoutingSimulate({ threadId, text, mode: "build" });
        const before = yield* c.TaskCostsList();
        yield* c.CommandDispatch({ type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId, text, mode: "build" });
        yield* Effect.promise(drain);
        const decision = yield* c.RoutingExplain({ taskId: turnId as string as TaskId });
        const missing = yield* Effect.flip(c.RoutingExplain({ taskId: uuid<TaskId>() }));
        return { preview, before, decision, missing };
      }),
    );
    expect(preview.reason).toBe("Looks like ask.search, so it runs on fake-small at low effort.");
    expect(before).toEqual([]);
    expect(decision).toEqual(preview);
    expect(decision.trace.map((t) => t.stage)).toContain("classify");
    expect(missing.reason).toBe("TaskNotFound");
  });

  test("RoutingSimulate says how to fix a thread with nothing to route to", async () => {
    const { info } = await startServer();
    const threadId = uuid<ThreadId>();
    const failure = await withClient(info.port, info.token, (c) =>
      Effect.gen(function* () {
        yield* c.CommandDispatch({ type: "thread.create", commandId: uuid<CommandId>(), threadId, projectPath: folder });
        return yield* Effect.flip(c.RoutingSimulate({ threadId, text: "hi", mode: "build" }));
      }),
    );
    expect(failure.reason).toBe("NoRoute");
    expect(failure.message).toContain("the claude-code harness isn't running");
    expect(failure.message).toContain("Pick a route for this thread");
  });

  test("thread.create resolves the folder, so two spellings of one folder are one project", async () => {
    const { info, runtime } = await startServer();
    const other = makeTempHome();
    cleanups.push(async () => removeTempHome(other));
    const link = join(other, "link to project");
    symlinkSync(folder, link, "junction"); // junctions need no admin rights on Windows; ignored elsewhere
    const file = join(other, "notes.txt");
    writeFileSync(file, "");
    const create = (c: Effect.Success<ReturnType<typeof connect>>, projectPath: string) =>
      c.CommandDispatch({ type: "thread.create", commandId: uuid<CommandId>(), threadId: uuid<ThreadId>(), projectPath, route });
    const rejected = await withClient(info.port, info.token, (c) =>
      Effect.gen(function* () {
        yield* create(c, `${folder}${sep}`);
        yield* create(c, link);
        return yield* Effect.forEach([join(other, "missing"), file, "relative"], (p) => Effect.flip(create(c, p)));
      }),
    );
    const projects = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SqlClient.SqlClient)<{ path: string }>`select path from projects`;
      }),
    );
    expect(projects.map((p) => p.path)).toEqual([realpathSync.native(folder)]);
    expect(rejected.map((e) => e.reason)).toEqual(["InvalidProjectPath", "InvalidProjectPath", "InvalidProjectPath"]);
    expect(rejected.map((e) => e.message)).toEqual([
      expect.stringContaining("does not exist"),
      expect.stringContaining("is a file"),
      expect.stringContaining("not an absolute path"),
    ]);
  });
});
