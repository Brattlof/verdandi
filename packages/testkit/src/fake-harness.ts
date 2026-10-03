import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
  TurnId,
} from "@verdandi/contracts";
import { Effect, Stream } from "effect";

/**
 * A scripted harness for tests. Text "fail" fails the turn, "hang" runs until interrupted, "gate" waits for
 * `release()`, "overage" reports a used-up subscription window and answers on metered usage, "approve" asks to edit a file, "ask" asks a question and "plan" proposes a plan (echoing the user's edit when approved with one), each
 * finishing once `respond` answers on the model of the route `reroute` last moved the turn to, "steer" waits for the first steer and answers it, "edit <path>"
 * appends a line to that file, relative to the turn's folder, through an Edit tool call, "write <path> <text>" writes the text to that file through a
 * Bash call, the way an agent's `cat >` would, and a turn Verdandi sends to escalate a failed verifier ("Verdandi ran the
 * project's verifier …") edits the thread's last edited file again, the way an agent fixing it would; "subagent" delegates a read to a subagent whose
 * steps carry `parentToolUseId`, "background" does the same in a background subagent that reports after the main
 * agent's reply, the way Claude Code's adapter delivers it; anything else is echoed back, with its attachments' names, kinds and sizes, and fixed usage on the route's model.
 * A turn with a `fork` starts a new session holding the old one's turns up to the fork; `history` keeps each session's turns.
 * "tool <name> <json args>" calls one of the Verdandi tools the run was given, reporting the call and its result as items.
 * "fetch <url>" reads that page through a WebFetch tool call first, then runs the turn's next lines as its text.
 * A background review's prompt ("Verdandi is reviewing a finished task …") is answered as a reviewer would, in JSON:
 * it proposes remembering, in project memory, whatever follows the digest's first "remember", and creating the skill
 * named after its first "skill:".
 * Every reply costs $0.01. Like Claude Code, it checks the task's `maxCost` after the call: when the task's
 * spend then exceeds it, the turn ends with status `limit`. Each turn is one model call against the task's `maxTurns`:
 * a task with none left ends its next turn with status `limit` at once. `calls` records every run.
 */
export const makeFakeHarness = () => {
  const calls: {
    resumeSessionId: string | undefined;
    route: Route;
    text: string;
    mode: InteractionMode;
    attachments: HarnessRunInput["attachments"];
    fork: HarnessRunInput["fork"];
    memory: HarnessRunInput["memory"];
    nudge: HarnessRunInput["nudge"];
  }[] = [];
  /** Every `reroute`, in order. A rerouted turn answers on its new route's model. */
  const reroutes: { threadId: ThreadId; route: Route }[] = [];
  const routes = new Map<ThreadId, Route>();
  /** Each thread's last `edit` path, which an escalation's handoff turn edits again. */
  const edited = new Map<ThreadId, string>();
  const routeOf = (input: HarnessRunInput) => routes.get(input.threadId) ?? input.route;
  const waiting = new Map<string, (resolution: Resolution) => void>();
  let sessions = 0;
  /** Each session's turns, as the agent would remember them. */
  const history = new Map<string, { turnId: TurnId; text: string }[]>();
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

  const script = (input: HarnessRunInput): Stream.Stream<HarnessEvent> => {
    if (input.text.startsWith("fetch ")) {
      // `fetch <url>` reads a page through Claude Code's WebFetch, untrusted input from the network, then runs the
      // turn's next lines as its text. The read comes once the session has started.
      const [first = "", ...rest] = input.text.split("\n");
      const url = first.slice("fetch ".length);
      const read = Stream.fromIterable<HarnessEvent>([
        { type: "item", item: { kind: "tool.call", toolUseId: "fake-fetch", name: "WebFetch", input: { url } } },
        { type: "item", item: { kind: "tool.result", toolUseId: "fake-fetch", isError: false, content: `the page at ${url}` } },
      ]);
      const fresh = input.resumeSessionId === undefined || input.fork !== undefined;
      const after = script({ ...input, text: rest.join("\n") || `fetched ${url}` });
      return fresh
        ? after.pipe(Stream.flatMap((e) => (e.type === "session.started" ? Stream.concat(Stream.succeed(e), read) : Stream.succeed(e))))
        : Stream.concat(read, after);
    }
    calls.push({
      resumeSessionId: input.resumeSessionId,
      route: input.route,
      text: input.text,
      mode: input.mode,
      attachments: input.attachments,
      fork: input.fork,
      memory: input.memory,
      nudge: input.nudge,
    });
    routes.set(input.threadId, input.route);
    // A fork starts a new session holding the old one's turns up to `atTurnId`, like Claude Code's (ADR 0004).
    const fresh = input.resumeSessionId === undefined || input.fork !== undefined;
    const sessionId = fresh ? `fake-session-${++sessions}` : (input.resumeSessionId ?? "");
    const kept = input.fork ? (history.get(input.resumeSessionId ?? "") ?? []) : (history.get(sessionId) ?? []);
    const upTo = input.fork ? kept.findIndex((t) => t.turnId === input.fork?.atTurnId) + 1 : kept.length;
    history.set(sessionId, [...kept.slice(0, upTo), { turnId: input.turnId, text: input.text }]);
    const start: HarnessEvent[] = fresh ? [{ type: "session.started", sessionId, harnessVersion: "fake" }] : [];
    if (input.text === "hang") return Stream.concat(Stream.fromIterable(start), Stream.never);
    if (input.text === "fail") return Stream.fromIterable([...start, { type: "turn.finished", status: "error", error: "fake failure" }]);
    if (input.text === "overage") {
      const quota: HarnessEvent = {
        type: "quota",
        quota: { status: "rejected", window: "five_hour", utilization: 1, resetsAt: "2099-01-01T00:00:00.000Z", usingOverage: true },
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
          r.decision === "allow"
            ? `built the plan${r.plan ? `: ${r.plan}` : ""}`
            : `kept planning${r.decision === "deny" && r.feedback ? `: ${r.feedback}` : ""}`,
      );
      return Stream.concat(Stream.fromIterable(start), plan);
    }
    if (input.text.startsWith("Verdandi is reviewing a finished task")) {
      const fact = /remember:?\s+([^\n`]+)/i.exec(input.text)?.[1]?.trim();
      const memories = fact ? [{ scope: "project", text: fact }] : [];
      const name = /\bskill: ([a-z][a-z0-9-]*)/.exec(input.text)?.[1];
      const skills = name
        ? [{ action: "create", name, content: `---\nname: ${name}\ndescription: A procedure a review proposed.\n---\nSteps.\n` }]
        : [];
      return Stream.concat(
        Stream.fromIterable(start),
        reply(input.route.model, `\`\`\`json\n${JSON.stringify({ memories, skills })}\n\`\`\``),
      );
    }
    const fixing = input.text.startsWith("Verdandi ran the project's verifier") ? edited.get(input.threadId) : undefined;
    if (input.text.startsWith("edit ") || fixing) {
      const path = fixing ?? resolve(input.cwd, input.text.slice("edit ".length));
      edited.set(input.threadId, path);
      const edit = Stream.suspend(() => {
        appendFileSync(path, "edited by the fake harness\n");
        return Stream.fromIterable<HarnessEvent>([
          { type: "item", item: { kind: "tool.call", toolUseId: "fake-edit", name: "Edit", input: { file_path: path } } },
          { type: "item", item: { kind: "tool.result", toolUseId: "fake-edit", isError: false, content: "ok" } },
        ]);
      });
      return Stream.concat(Stream.fromIterable(start), Stream.concat(edit, reply(input.route.model, `edited ${path}`)));
    }
    if (input.text.startsWith("write ")) {
      const [, path = "", ...words] = input.text.split(" ");
      const command = `cat > ${path}`;
      const write = Stream.suspend(() => {
        writeFileSync(resolve(input.cwd, path), words.join(" "));
        return Stream.fromIterable<HarnessEvent>([
          { type: "item", item: { kind: "tool.call", toolUseId: "fake-write", name: "Bash", input: { command } } },
          { type: "item", item: { kind: "tool.result", toolUseId: "fake-write", isError: false, content: "" } },
        ]);
      });
      return Stream.concat(Stream.fromIterable(start), Stream.concat(write, reply(input.route.model, `wrote ${path}`)));
    }
    if (input.text.startsWith("tool ")) {
      // `tool <name> <json args>` calls one of Verdandi's tools the run was given, as Claude Code's MCP client would.
      const [, name = "", ...rest] = input.text.split(" ");
      const args = rest.length > 0 ? (JSON.parse(rest.join(" ")) as Record<string, unknown>) : {};
      const toolUseId = `fake-tool-${name}`;
      const called = Stream.unwrap(
        Effect.promise(async () => {
          const tool = input.tools?.find((t) => t.name === name);
          const result = tool
            ? await tool.call(args, { threadId: input.threadId, turnId: input.turnId })
            : { text: `There's no Verdandi tool ${name}.`, isError: true };
          return Stream.concat(
            Stream.fromIterable<HarnessEvent>([
              { type: "item", item: { kind: "tool.call", toolUseId, name: `mcp__verdandi__${name}`, input: args } },
              { type: "item", item: { kind: "tool.result", toolUseId, isError: result.isError === true, content: result.text } },
            ]),
            reply(input.route.model, `called ${name}`),
          );
        }),
      );
      return Stream.concat(Stream.fromIterable(start), called);
    }
    if (input.text.startsWith("skill ")) {
      // `skill <name>` reports loading a skill the way Claude Code's Skill tool call shows; the fake harness loads nothing.
      const skill = input.text.slice("skill ".length);
      const steps: HarnessEvent[] = [
        { type: "item", item: { kind: "tool.call", toolUseId: "fake-skill", name: "Skill", input: { skill } } },
        { type: "item", item: { kind: "tool.result", toolUseId: "fake-skill", isError: false, content: `Launching skill: ${skill}` } },
      ];
      return Stream.concat(Stream.fromIterable([...start, ...steps]), reply(input.route.model, `used ${skill}`));
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
    const attached = input.attachments?.length
      ? ` [attached: ${input.attachments.map((a) => `${a.name} (${a.kind}, ${a.size} bytes)`).join(", ")}]`
      : "";
    const echo = Stream.concat(
      Stream.fromIterable<HarnessEvent>([
        { type: "text.delta", text: "echo: " },
        { type: "text.delta", text: input.text + attached },
      ]),
      reply(input.route.model, `echo: ${input.text}${attached}`),
    );
    const waitForGate = input.text === "gate" ? Stream.unwrap(Effect.promise(() => gate).pipe(Effect.as(echo))) : echo;
    return Stream.concat(Stream.fromIterable(start), waitForGate);
  };

  /** Every `close`, in order: a thread's id, or undefined for all of them. */
  const closes: (ThreadId | undefined)[] = [];
  const adapter: HarnessAdapter & {
    calls: typeof calls;
    reroutes: typeof reroutes;
    history: typeof history;
    closes: typeof closes;
    release: () => void;
  } = {
    id: "fake",
    calls,
    history,
    reroutes,
    closes,
    release: () => release(),
    run(input: HarnessRunInput) {
      // Each turn is one model call, reported first, as a real harness reports each as it's made.
      const maxTurns = input.limits?.maxTurns;
      if (maxTurns !== undefined && input.limits && input.limits.spentTurns >= maxTurns)
        return Stream.make<HarnessEvent[]>({
          type: "turn.finished",
          status: "limit",
          error: `Stopped at the task's ${maxTurns}-turn limit.`,
        });
      const called = Stream.fromIterable<HarnessEvent>(maxTurns === undefined ? [] : [{ type: "model.called" }]);
      const maxCost = input.limits?.maxCost;
      const over = maxCost !== undefined && (input.limits?.spentUsd ?? 0) + 0.01 > maxCost;
      const stopped: HarnessEvent = { type: "turn.finished", status: "limit", error: `Stopped at the task's $${maxCost} cost limit.` };
      const turn = over
        ? Stream.map(script(input), (e) => (e.type === "turn.finished" && e.status === "success" ? stopped : e))
        : script(input);
      return Stream.concat(called, turn);
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
    close: (threadId) => Effect.sync(() => void closes.push(threadId)),
  };
  return adapter;
};
