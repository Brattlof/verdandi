import type { HarnessAdapter, HarnessEvent, HarnessRunInput } from "@goldiloop/contracts";
import { Effect, Stream } from "effect";

/**
 * A scripted harness for tests. Text "fail" fails the turn, "hang" never finishes, "gate" waits for
 * `release()`, anything else is echoed back with fixed usage. `calls` records every run.
 */
export const makeFakeHarness = () => {
  const calls: { resumeSessionId: string | undefined; text: string }[] = [];
  let sessions = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const adapter: HarnessAdapter & { calls: typeof calls; release: () => void } = {
    id: "fake",
    calls,
    release: () => release(),
    run(input: HarnessRunInput) {
      calls.push({ resumeSessionId: input.resumeSessionId, text: input.text });
      const start: HarnessEvent[] =
        input.resumeSessionId === undefined
          ? [{ type: "session.started", sessionId: `fake-session-${++sessions}`, harnessVersion: "fake" }]
          : [];
      if (input.text === "hang") return Stream.concat(Stream.fromIterable(start), Stream.never);
      if (input.text === "fail") return Stream.fromIterable([...start, { type: "turn.finished", status: "error", error: "fake failure" }]);
      const echo = Stream.fromIterable<HarnessEvent>([
        { type: "text.delta", text: "echo: " },
        { type: "text.delta", text: input.text },
        { type: "item", item: { kind: "assistant.message", text: `echo: ${input.text}` } },
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
      const waitForGate = input.text === "gate" ? Stream.unwrap(Effect.promise(() => gate).pipe(Effect.as(echo))) : echo;
      return Stream.concat(Stream.fromIterable(start), waitForGate);
    },
  };
  return adapter;
};
