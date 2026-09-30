import { appendFileSync } from "node:fs";
import type {
  AccessMode,
  HarnessAdapter,
  HarnessEvent,
  HarnessRunInput,
  InteractionMode,
  Item,
  Resolution,
  Route,
  ThreadId,
} from "@verdandi/contracts";
import { Effect, Stream } from "effect";

/**
 * A scripted harness for tests. Text "fail" fails the turn, "hang" runs until interrupted, "gate" waits for
 * `release()`, "overage" reports a used-up subscription window and answers on metered usage, "approve" asks to edit a file, "ask" asks a question and "plan" proposes a plan, each
 * finishing once `respond` answers on the model of the route `reroute` last moved the turn to, "steer" waits for the first steer and answers it, "edit <path>"
 * appends a line to that file through an Edit tool call, "subagent" delegates a read to a subagent whose
 * steps carry `parentToolUseId`, "background" does the same in a background subagent that reports after the main
 * agent's reply, the way Claude Code's adapter delivers it; anything else is echoed back with fixed usage on the route's model.
 * `calls` records every run.
 */
export const makeFakeHarness = () => {
  const calls: { resumeSessionId: string | undefined; route: Route; text: string; mode: InteractionMode }[] = [];
  /** Every `reroute`, in order. A rerouted turn answers on its new route's model. */
  const reroutes: { threadId: ThreadId; route: Route }[] = [];
  const routes = new Map<ThreadId, Route>();
  const routeOf = (input: HarnessRunInput) => routes.get(input.threadId) ?? input.route;
  const waiting = new Map<string, (resolution: Resolution) => void>();
  let sessions = 0;
  let requests = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));

  const reply = (model: string, text: string, accessMode: AccessMode = "subscription") =>
    Stream.fromIterable<HarnessEvent>([
      { type: "item", item: { kind: "assistant.message", text } },
      {
        type: "usage",
        model,
        accessMode,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.01,
      },
      { type: "turn.finished", status: "success" },
    ]);

  /** Reports the request, then replies with what `answer` makes of the resolution. */
  const request = (input: HarnessRunInput, event: (requestId: string) => HarnessEvent, answer: (r: Resolution) => string) => {
    const requestId = `fake-request-${++requests}`;
    // Registered before the request is reported, so an answer can never arrive first.
    const answered = new Promise<Resolution>((resolve) => waiting.set(requestId, resolve));
    return Stream.concat(
      Stream.succeed(event(requestId)),
      // Read once answered: `reroute` may have moved the turn meanwhile.
      Stream.unwrap(Effect.promise(() => answered).pipe(Effect.map((r) => reply(routeOf(input).model, answer(r))))),
    );
  };

  const adapter: HarnessAdapter & { calls: typeof calls; reroutes: typeof reroutes; release: () => void } = {
    id: "fake",
    calls,
    reroutes,
    release: () => release(),
    run(input: HarnessRunInput) {
      calls.push({ resumeSessionId: input.resumeSessionId, route: input.route, text: input.text, mode: input.mode });
      routes.set(input.threadId, input.route);
      const start: HarnessEvent[] =
        input.resumeSessionId === undefined
          ? [{ type: "session.started", sessionId: `fake-session-${++sessions}`, harnessVersion: "fake" }]
          : [];
      if (input.text === "hang") return Stream.concat(Stream.fromIterable(start), Stream.never);
      if (input.text === "fail") return Stream.fromIterable([...start, { type: "turn.finished", status: "error", error: "fake failure" }]);
      if (input.text === "overage") {
        const quota: HarnessEvent = {
          type: "quota",
          quota: { status: "rejected", window: "five_hour", utilization: 1, resetsAt: "2026-10-01T00:00:00.000Z", usingOverage: true },
        };
        return Stream.concat(Stream.fromIterable([...start, quota]), reply(input.route.model, "on extra usage", "metered"));
      }
      if (input.text === "approve") {
        const edit = request(
          input,
          (requestId) => ({ type: "approval.requested", requestId, toolName: "Edit", input: { file_path: "a.txt" } }),
          (r) => (r.decision === "allow" ? "edited a.txt" : "left a.txt alone"),
        );
        return Stream.concat(Stream.fromIterable(start), edit);
      }
      if (input.text === "ask") {
        const question = "Which color?";
        const ask = request(
          input,
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
          input,
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
      if (input.text === "subagent") {
        const parentToolUseId = "fake-agent-1";
        const steps = (
          [
            { kind: "tool.call", toolUseId: parentToolUseId, name: "Agent", input: { prompt: "Read a.txt" } },
            { kind: "tool.call", toolUseId: "fake-read-1", name: "Read", input: { file_path: "a.txt" }, parentToolUseId },
            { kind: "tool.result", toolUseId: "fake-read-1", isError: false, content: "hello", parentToolUseId },
            { kind: "assistant.message", text: "a.txt says hello", parentToolUseId },
            { kind: "tool.result", toolUseId: parentToolUseId, isError: false, content: "a.txt says hello" },
          ] satisfies Item[]
        ).map((item): HarnessEvent => ({ type: "item", item }));
        return Stream.concat(Stream.fromIterable([...start, ...steps]), reply(input.route.model, "the subagent read a.txt"));
      }
      if (input.text === "background") {
        const parentToolUseId = "fake-agent-1";
        const steps = (
          [
            { kind: "tool.call", toolUseId: parentToolUseId, name: "Agent", input: { prompt: "Read a.txt", run_in_background: true } },
            { kind: "tool.result", toolUseId: parentToolUseId, isError: false, content: "Async agent launched successfully." },
            { kind: "assistant.message", text: "launched a subagent" },
            { kind: "tool.call", toolUseId: "fake-read-1", name: "Read", input: { file_path: "a.txt" }, parentToolUseId },
            { kind: "tool.result", toolUseId: "fake-read-1", isError: false, content: "hello", parentToolUseId },
            { kind: "assistant.message", text: "a.txt says hello", parentToolUseId },
          ] satisfies Item[]
        ).map((item): HarnessEvent => ({ type: "item", item }));
        return Stream.concat(Stream.fromIterable([...start, ...steps]), reply(input.route.model, "the background subagent read a.txt"));
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
    reroute: (threadId, route) =>
      Effect.sync(() => {
        reroutes.push({ threadId, route });
        if (routes.has(threadId)) routes.set(threadId, route);
      }),
  };
  return adapter;
};
