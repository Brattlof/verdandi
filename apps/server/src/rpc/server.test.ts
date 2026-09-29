import { afterEach, describe, expect, test } from "bun:test";
import type { CommandId, ThreadFeed, ThreadId, TurnId } from "@goldiloop/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@goldiloop/testkit";
import { Effect, ManagedRuntime, Stream } from "effect";
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

const createThread = (client: Effect.Success<ReturnType<typeof connect>>, threadId: ThreadId) =>
  client.CommandDispatch({ type: "thread.create", commandId: uuid<CommandId>(), threadId, projectPath: "C:/Users/a b/repo", route });

describe("rpc server", () => {
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
        yield* createThread(c, threadId);
        const subscriptionId = crypto.randomUUID();
        const seen: string[] = [];
        yield* c.ThreadSubscribe({ threadId, subscriptionId }).pipe(
          Stream.runForEach((f: ThreadFeed) =>
            Effect.gen(function* () {
              seen.push(f.kind === "event" ? f.stored.event.type : f.kind);
              if (f.kind === "snapshot")
                yield* c.CommandDispatch({ type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId: uuid<TurnId>(), text: "hi" });
              if (f.kind === "event" && f.stored.event.type === "turn.completed") yield* c.ThreadUnsubscribe({ subscriptionId });
            }),
          ),
        );
        const after = yield* createThread(c, uuid<ThreadId>());
        return [seen, after] as const;
      }),
    );
    expect(kinds[0]).toBe("snapshot");
    expect(kinds).toContain("turn.started");
    expect(kinds).toContain("delta");
    expect(kinds.at(-1)).toBe("turn.completed");
    expect(after.seq).toBeGreaterThan(0); // the connection still answers after the feed ended (ADR 0008)
  });

  test("turn survives client disconnect", async () => {
    const { info, fake, drain } = await startServer();
    const threadId = uuid<ThreadId>();
    await withClient(info.port, info.token, (c) =>
      Effect.gen(function* () {
        yield* createThread(c, threadId);
        yield* c.CommandDispatch({ type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId: uuid<TurnId>(), text: "gate" });
      }),
    );
    fake.release();
    await drain();
    const statuses = await withClient(info.port, info.token, (c) =>
      Effect.gen(function* () {
        const subscriptionId = crypto.randomUUID();
        let statuses: string[] = [];
        // End the feed with ThreadUnsubscribe, never by stopping the stream early (ADR 0008).
        yield* c.ThreadSubscribe({ threadId, subscriptionId }).pipe(
          Stream.runForEach((f: ThreadFeed) => {
            if (f.kind !== "snapshot") return Effect.void;
            statuses = f.thread.turns.map((t) => t.status);
            return c.ThreadUnsubscribe({ subscriptionId });
          }),
        );
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
        Effect.exit(c.CommandDispatch({ type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId: uuid<TurnId>(), text: "gate" })),
      );
    const results = await Promise.all([send(), send()]);
    fake.release();
    const outcomes = results
      .map((r) => (r._tag === "Success" ? "ok" : JSON.stringify(r.cause).includes("ThreadBusy") ? "busy" : "other"))
      .sort();
    expect(outcomes).toEqual(["busy", "ok"]);
  });
});
