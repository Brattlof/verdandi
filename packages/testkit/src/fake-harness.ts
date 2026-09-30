import { appendFileSync } from "node:fs";
import type { HarnessAdapter, HarnessEvent, HarnessRunInput, InteractionMode, Resolution, Route } from "@verdandi/contracts";
import { Effect, Stream } from "effect";

/**
 * A scripted harness for tests. Text "fail" fails the turn, "hang" runs until interrupted, "gate" waits for
 * `release()`, "approve" asks to edit a file, "ask" asks a question and "plan" proposes a plan, each
 * finishing once `respond` answers, "steer" waits for the first steer and answers it, "edit <path>"
 * appends a line to that file through an Edit tool call; anything else is echoed back with fixed usage on the route's model. `calls` records every run.
 */
export const makeFakeHarness = () => {
  const calls: { resumeSessionId: string | undefined; route: Route; text: string; mode: InteractionMode }[] = [];
  const waiting = new Map<string, (resolution: Resolution) => void>();
  let sessions = 0;
  let requests = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));

  const reply = (model: string, text: string) =>
    Stream.fromIterable<HarnessEvent>([
      { type: "item", item: { kind: "assistant.message", text } },
      {
        type: "usage",
        model,
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
  const request = (model: string, event: (requestId: string) => HarnessEvent, answer: (r: Resolution) => string) => {
    const requestId = `fake-request-${++requests}`;
    // Registered before the request is reported, so an answer can never arrive first.
    const answered = new Promise<Resolution>((resolve) => waiting.set(requestId, resolve));
    return Stream.concat(
      Stream.succeed(event(requestId)),
      Stream.unwrap(Effect.promise(() => answered).pipe(Effect.map((r) => reply(model, answer(r))))),
    );
  };

  const adapter: HarnessAdapter & { calls: typeof calls; release: () => void } = {
    id: "fake",
    calls,
    release: () => release(),
    run(input: HarnessRunInput) {
      calls.push({ resumeSessionId: input.resumeSessionId, route: input.route, text: input.text, mode: input.mode });
      const start: HarnessEvent[] =
        input.resumeSessionId === undefined
          ? [{ type: "session.started", sessionId: `fake-session-${++sessions}`, harnessVersion: "fake" }]
          : [];
      if (input.text === "hang") return Stream.concat(Stream.fromIterable(start), Stream.never);
      if (input.text === "fail") return Stream.fromIterable([...start, { type: "turn.finished", status: "error", error: "fake failure" }]);
      if (input.text === "approve") {
        const edit = request(
          input.route.model,
          (requestId) => ({ type: "approval.requested", requestId, toolName: "Edit", input: { file_path: "a.txt" } }),
          (r) => (r.decision === "allow" ? "edited a.txt" : "left a.txt alone"),
        );
        return Stream.concat(Stream.fromIterable(start), edit);
      }
      if (input.text === "ask") {
        const question = "Which color?";
        const ask = request(
          input.route.model,
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
      if (input.text === "plan") {
        const plan = request(
          input.route.model,
          (requestId) => ({ type: "plan.requested", requestId, plan: "1. Edit a.txt" }),
          (r) =>
            r.decision === "allow" ? "built the plan" : `kept planning${r.decision === "deny" && r.feedback ? `: ${r.feedback}` : ""}`,
        );
        return Stream.concat(Stream.fromIterable(start), plan);
      }
      if (input.text.startsWith("edit ")) {
        const path = input.text.slice("edit ".length);
        const edit = Stream.suspend(() => {
          appendFileSync(path, "edited by the fake harness\n");
          return Stream.fromIterable<HarnessEvent>([
            { type: "item", item: { kind: "tool.call", toolUseId: "fake-edit", name: "Edit", input: { file_path: path } } },
            { type: "item", item: { kind: "tool.result", toolUseId: "fake-edit", isError: false, content: "ok" } },
          ]);
        });
        return Stream.concat(Stream.fromIterable(start), Stream.concat(edit, reply(input.route.model, `edited ${path}`)));
      }
      if (input.text === "steer") {
        const answer = input.steers.pipe(
          Stream.take(1),
          Stream.flatMap((steer) => reply(input.route.model, `steered: ${steer}`)),
        );
        return Stream.concat(Stream.fromIterable(start), answer);
      }
      const echo = Stream.concat(
        Stream.fromIterable<HarnessEvent>([
          { type: "text.delta", text: "echo: " },
          { type: "text.delta", text: input.text },
        ]),
        reply(input.route.model, `echo: ${input.text}`),
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
