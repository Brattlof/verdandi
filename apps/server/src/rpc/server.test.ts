import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandId, ProjectsFeed, ThreadFeed, ThreadId, TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, makeTempRepo, removeTempHome } from "@verdandi/testkit";
import { Deferred, Effect, Fiber, ManagedRuntime, Stream } from "effect";
import { Reactor } from "../orchestration/reactor.ts";
import { connect } from "./client.ts";
import { ServerInfo, ServerLayer } from "./server.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

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
  return { info, fake, drain, home };
};

/** Runs `f` with a connected client in its own scope; the socket closes when `f` returns. */
const withClient = <A, E>(port: number, token: string, f: (client: Effect.Success<ReturnType<typeof connect>>) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.scoped(Effect.flatMap(connect({ port, token }), f)));

/** Fails with the step's name instead of hanging until the test timeout, so a CI hang says where it stuck. */
const step = <A, E>(label: string, e: Effect.Effect<A, E>) =>
  e.pipe(Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.die(`step timed out: ${label}`) }));

const createThread = (client: Effect.Success<ReturnType<typeof connect>>, threadId: ThreadId) =>
  client.CommandDispatch({ type: "thread.create", commandId: uuid<CommandId>(), threadId, projectPath: "C:/Users/a b/repo", route });

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
    expect(snapshot.projects.map((p) => p.path)).toEqual(["C:/Users/a b/repo"]);
    expect(changes.map((c) => [c.thread.threadId, c.thread.busy, c.thread.title])).toEqual([
      [threadId, false, ""],
      [threadId, true, "gate"],
      [threadId, false, "gate"],
    ]);
    expect(changes[0]?.project?.path).toBe("C:/Users/a b/repo");
    expect(changes[1]?.project).toBeUndefined();
    expect(changes.map((c) => c.seq)).toEqual(changes.map((c) => c.seq).sort((a, b) => a - b));
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
    expect(error.message).toContain("does not exist");
  });
});
