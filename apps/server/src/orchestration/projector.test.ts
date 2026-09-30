import { afterEach, expect, test } from "bun:test";
import type { Event, StoredEvent, ThreadId, TurnId } from "@verdandi/contracts";
import { makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { SqlLive } from "../persistence/db.ts";
import { loadThreadView, project } from "./projector.ts";

const homes: string[] = [];
const tempHome = () => {
  const home = makeTempHome();
  homes.push(home);
  return home;
};
afterEach(() => {
  for (const h of homes.splice(0)) removeTempHome(h);
});

const threadId = "thread-1" as ThreadId;
const turnId = "turn-1" as TurnId;
let seq = 0;
const stored = (event: Event): StoredEvent => ({
  seq: ++seq,
  eventId: `e${seq}`,
  commandId: `c${seq}`,
  at: "2026-09-29T12:00:00.000Z",
  event,
});

const turn: Event[] = [
  {
    type: "thread.created",
    v: 1,
    threadId,
    projectId: "p" as never,
    projectPath: "C:/Users/a b/repo",
    route: { harness: "fake", model: "fake", effort: "low" },
  },
  { type: "turn.started", v: 1, threadId, turnId, text: "hi" },
  { type: "harness.session.bound", v: 1, threadId, sessionId: "s1", harnessVersion: "fake" },
  { type: "turn.item.added", v: 1, threadId, turnId, item: { kind: "assistant.message", text: "echo: hi" } },
  {
    type: "turn.usage.recorded",
    v: 1,
    threadId,
    turnId,
    model: "fake",
    accessMode: "subscription",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  },
  { type: "turn.completed", v: 1, threadId, turnId, status: "success" },
];

const run = <A>(home: string, effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SqlLive(home))));

test("projects a full turn into the thread view", async () => {
  const home = tempHome();
  const view = await run(
    home,
    Effect.gen(function* () {
      for (const e of turn) yield* project(stored(e));
      return yield* loadThreadView(threadId);
    }),
  );
  expect(view).toEqual({
    threadId,
    projectPath: "C:/Users/a b/repo",
    route: { harness: "fake", model: "fake", effort: "low" },
    sessionId: "s1",
    busy: false,
    turns: [
      {
        turnId,
        text: "hi",
        mode: "build",
        status: "success",
        items: [{ kind: "assistant.message", text: "echo: hi" }],
        usage: [
          {
            model: "fake",
            accessMode: "subscription",
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
          },
        ],
      },
    ],
    routeChanges: [],
    pendingRequests: [],
  });
});

test("a running turn makes the thread busy", async () => {
  const home = tempHome();
  const view = await run(
    home,
    Effect.gen(function* () {
      for (const e of turn.slice(0, 2)) yield* project(stored(e));
      return yield* loadThreadView(threadId);
    }),
  );
  expect(view?.busy).toBe(true);
  expect(view?.turns[0]?.status).toBe("running");
});

test("migrations are idempotent", async () => {
  const home = tempHome();
  await run(home, project(stored(turn[0] as Event)));
  const view = await run(home, loadThreadView(threadId));
  expect(view?.threadId).toBe(threadId);
});
