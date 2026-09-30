import type { HarnessAdapter, HarnessEvent, HarnessRunInput, Resolution } from "@verdandi/contracts";
import { Effect, Stream } from "effect";

/**
 * A scripted harness for tests. Text "fail" fails the turn, "hang" never finishes, "gate" waits for
 * `release()`, "approve" asks to edit a file and "ask" asks a question, each finishing once `respond`
 * answers; anything else is echoed back with fixed usage. `calls` records every run.
 */
export const makeFakeHarness = () => {
  const calls: { resumeSessionId: string | undefined; text: string }[] = [];
  const waiting = new Map<string, (resolution: Resolution) => void>();
  let sessions = 0;
  let requests = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));

  const reply = (text: string) =>
    Stream.fromIterable<HarnessEvent>([
      { type: "item", item: { kind: "assistant.message", text } },
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

  /** Reports the request, then replies with what `answer` makes of the resolution. */
  const request = (event: (requestId: string) => HarnessEvent, answer: (r: Resolution) => string) => {
    const requestId = `fake-request-${++requests}`;
    // Registered before the request is reported, so an answer can never arrive first.
    const answered = new Promise<Resolution>((resolve) => waiting.set(requestId, resolve));
    return Stream.concat(
      Stream.succeed(event(requestId)),
      Stream.unwrap(Effect.promise(() => answered).pipe(Effect.map((r) => reply(answer(r))))),
    );
  };

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
      if (input.text === "approve") {
        const edit = request(
          (requestId) => ({ type: "approval.requested", requestId, toolName: "Edit", input: { file_path: "a.txt" } }),
          (r) => (r.decision === "allow" ? "edited a.txt" : "left a.txt alone"),
        );
        return Stream.concat(Stream.fromIterable(start), edit);
      }
      if (input.text === "ask") {
        const question = "Which color?";
        const ask = request(
          (requestId) => ({
            type: "user-input.requested",
            requestId,
            questions: [
              {
                question,
                header: "Color",
                options: [
                  { label: "Red", description: "warm" },
                  { label: "Blue", description: "cool" },
                ],
                multiSelect: false,
              },
            ],
          }),
          (r) => (r.decision === "answer" ? `you picked ${r.answers[question]}` : "no answer"),
        );
        return Stream.concat(Stream.fromIterable(start), ask);
      }
      const echo = Stream.concat(
        Stream.fromIterable<HarnessEvent>([
          { type: "text.delta", text: "echo: " },
          { type: "text.delta", text: input.text },
        ]),
        reply(`echo: ${input.text}`),
      );
      const waitForGate = input.text === "gate" ? Stream.unwrap(Effect.promise(() => gate).pipe(Effect.as(echo))) : echo;
      return Stream.concat(Stream.fromIterable(start), waitForGate);
    },
    respond: (_threadId, requestId, resolution) =>
      Effect.sync(() => {
        waiting.get(requestId)?.(resolution);
        waiting.delete(requestId);
      }),
  };
  return adapter;
};
