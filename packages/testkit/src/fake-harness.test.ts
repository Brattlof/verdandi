import { expect, test } from "bun:test";
import type { HarnessEvent, ThreadId, TurnId } from "@verdandi/contracts";
import { Effect, Stream } from "effect";
import { makeFakeHarness } from "./fake-harness.ts";

const base = {
  threadId: "t" as ThreadId,
  cwd: "C:/Users/a b/repo",
  route: { harness: "fake", model: "fake", effort: "low" } as const,
};

const collect = (s: Stream.Stream<HarnessEvent, unknown>) => Effect.runPromise(Stream.runCollect(s)).then((c) => Array.from(c));

test("echoes the text and reports usage", async () => {
  const fake = makeFakeHarness();
  const events = await collect(fake.run({ ...base, resumeSessionId: undefined, turnId: "u1" as TurnId, text: "hi" }));
  expect(events.slice(-3)).toEqual([
    { type: "item", item: { kind: "assistant.message", text: "echo: hi" } },
    {
      type: "usage",
      model: "fake",
      accessMode: "subscription",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    },
    { type: "turn.finished", status: "success" },
  ]);
});

test("reuses the session when resumed", async () => {
  const fake = makeFakeHarness();
  const first = await collect(fake.run({ ...base, resumeSessionId: undefined, turnId: "u1" as TurnId, text: "a" }));
  const started = first.find((e) => e.type === "session.started");
  if (started?.type !== "session.started") throw new Error("no session.started");
  const second = await collect(fake.run({ ...base, resumeSessionId: started.sessionId, turnId: "u2" as TurnId, text: "b" }));
  expect(second.some((e) => e.type === "session.started")).toBe(false);
  expect(fake.calls[1]?.resumeSessionId).toBe(started.sessionId);
});

test("a gated turn waits until released", async () => {
  const fake = makeFakeHarness();
  let done = false;
  const running = collect(fake.run({ ...base, resumeSessionId: undefined, turnId: "u1" as TurnId, text: "gate" })).then((e) => {
    done = true;
    return e;
  });
  await Bun.sleep(0);
  expect(done).toBe(false);
  fake.release();
  expect((await running).at(-1)).toEqual({ type: "turn.finished", status: "success" });
});

test("reports a scripted failure as a failed turn", async () => {
  const fake = makeFakeHarness();
  const events = await collect(fake.run({ ...base, resumeSessionId: undefined, turnId: "u1" as TurnId, text: "fail" }));
  expect(events.at(-1)).toEqual({ type: "turn.finished", status: "error", error: "fake failure" });
});
