import type { HarnessAdapter, HarnessEvent, HarnessRunInput } from "@goldiloop/contracts";
import { Stream } from "effect";

/**
 * A scripted harness for tests. Text "fail" fails the turn, "hang" never finishes, anything else
 * is echoed back with fixed usage. `calls` records every run.
 */
export const makeFakeHarness = () => {
  const calls: { resumeSessionId: string | undefined; text: string }[] = [];
  let sessions = 0;
  const adapter: HarnessAdapter & { calls: typeof calls } = {
    id: "fake",
    calls,
    run(input: HarnessRunInput) {
      calls.push({ resumeSessionId: input.resumeSessionId, text: input.text });
      const start: HarnessEvent[] =
        input.resumeSessionId === undefined
          ? [{ type: "session.started", sessionId: `fake-session-${++sessions}`, harnessVersion: "fake" }]
          : [];
      if (input.text === "hang") return Stream.concat(Stream.fromIterable(start), Stream.never);
      if (input.text === "fail") return Stream.fromIterable([...start, { type: "turn.finished", status: "error", error: "fake failure" }]);
      return Stream.fromIterable<HarnessEvent>([
        ...start,
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
    },
  };
  return adapter;
};
