import { describe, expect, test } from "bun:test";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessRunInput, InteractionMode, Route, ThreadId, TurnId } from "@verdandi/contracts";
import { makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, Fiber, Stream } from "effect";
import { makeClaudeCodeAdapter, type QueryFn } from "./adapter.ts";
import { assistant, init, result, textDelta, turn1Usage, turn2Usage } from "./fixtures.ts";

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
const U3 = "00000000-0000-4000-8000-000000000003";

/** A fake SDK `query`: answers each prompt with a delta and a result; records what it was given, in order. */
const stubQuery = (
  script: (
    prompt: string,
    options: Options,
    message: SDKUserMessage,
    interrupted: Promise<void>,
  ) => SDKMessage[] | AsyncIterable<SDKMessage> = () => [textDelta("ok"), result(turn1Usage)],
  first: SDKMessage = init,
) => {
  const spawns: { options: Options; prompts: SDKUserMessage[]; log: string[] }[] = [];
  const query = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const record = { options: params.options, prompts: [] as SDKUserMessage[], log: [] as string[] };
    spawns.push(record);
    const interrupted = Promise.withResolvers<void>();
    const messages = (async function* () {
      yield first;
      for await (const m of params.prompt) {
        record.prompts.push(m);
        record.log.push(`prompt ${m.message.content}`);
        yield* script(String(m.message.content), params.options, m, interrupted.promise);
      }
    })();
    return Object.assign(messages, {
      setModel: async (model: string) => void record.log.push(`setModel ${model}`),
      applyFlagSettings: async (settings: object) => void record.log.push(`applyFlagSettings ${JSON.stringify(settings)}`),
      setPermissionMode: async (mode: string) => void record.log.push(`setPermissionMode ${mode}`),
      interrupt: async () => {
        record.log.push("interrupt");
        interrupted.resolve();
      },
      close: () => void record.log.push("close"),
    });
  }) as unknown as QueryFn;
  return { query, spawns };
};

const threadId = "thread-1" as ThreadId;
const haikuLow: Route = { harness: "claude-code", model: "haiku", effort: "low" };

const input = (
  cwd: string,
  text: string,
  turnId: string,
  resumeSessionId?: string,
  steers: Stream.Stream<string> = Stream.empty,
  route = haikuLow,
  mode: InteractionMode = "build",
): HarnessRunInput => ({
  threadId,
  cwd,
  route,
  resumeSessionId,
  turnId: turnId as TurnId,
  text,
  mode,
  steers,
});

describe("Claude Code adapter", () => {
  test("missing cwd names the path", async () => {
    const { query, spawns } = stubQuery();
    const adapter = makeClaudeCodeAdapter({ claudePath: "claude.exe", query });
    const missing = "C:\\Users\\nobody\\no such folder";
    const exit = await Effect.runPromise(Effect.exit(Stream.runCollect(adapter.run(input(missing, "hi", U1)))));
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("no such folder");
    expect(spawns).toHaveLength(0);
  });

  test("keeps one session per thread and tags prompts with the turn id", async () => {
    const home = makeTempHome();
    try {
      const { query, spawns } = stubQuery();
      const adapter = makeClaudeCodeAdapter({ claudePath: "C:\\bin\\claude.exe", query });
      const first = await Effect.runPromise(Stream.runCollect(adapter.run(input(home, "one", U1))));
      const second = await Effect.runPromise(Stream.runCollect(adapter.run(input(home, "two", U2, "sess-1"))));
      expect(Array.from(first).map((e) => e.type)).toEqual(["session.started", "text.delta", "usage", "usage", "turn.finished"]);
      expect(Array.from(second).map((e) => e.type)).toEqual(["text.delta", "turn.finished"]);
      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.prompts.map((p) => p.uuid)).toEqual([U1, U2] as never);
      expect(spawns[0]?.options).toMatchObject({
        pathToClaudeCodeExecutable: "C:\\bin\\claude.exe",
        cwd: home,
        model: "haiku",
        effort: "low",
        includePartialMessages: true,
        settings: { disableClaudeAiConnectors: true },
      });
    } finally {
      removeTempHome(home);
    }
  });

  test("canUseTool raises a request and waits for its answer", async () => {
    const home = makeTempHome();
    try {
      const questions = [
        {
          question: "Which?",
          header: "Pick",
          options: [
            { label: "A", description: "a" },
            { label: "B", description: "b" },
          ],
          multiSelect: false,
        },
      ];
      const decisions: unknown[] = [];
      const { query } = stubQuery(async function* (_prompt, options) {
        const ask = (tool: string, toolInput: Record<string, unknown>) =>
          options.canUseTool?.(tool, toolInput, { signal: new AbortController().signal, toolUseID: "toolu_1", requestId: "c1" });
        decisions.push(await ask("Edit", { file_path: "a.txt" }));
        decisions.push(await ask("AskUserQuestion", { questions }));
        yield result(turn1Usage);
      });
      const adapter = makeClaudeCodeAdapter({ claudePath: "claude.exe", query });
      const seen: string[] = [];
      await Effect.runPromise(
        adapter.run(input(home, "edit", U1)).pipe(
          Stream.runForEach((e) => {
            seen.push(e.type);
            if (e.type === "approval.requested") return adapter.respond(threadId, e.requestId, { decision: "deny" });
            if (e.type === "user-input.requested") {
              expect(e.questions).toEqual(questions);
              return adapter.respond(threadId, e.requestId, { decision: "answer", answers: { "Which?": "B" } });
            }
            return Effect.void;
          }),
        ),
      );
      expect(seen).toEqual(["session.started", "approval.requested", "user-input.requested", "usage", "usage", "turn.finished"]);
      expect(decisions).toEqual([
        { behavior: "deny", message: "The user denied this." },
        { behavior: "allow", updatedInput: { questions, answers: { "Which?": "B" } } },
      ]);
    } finally {
      removeTempHome(home);
    }
  });

  test("a route change reaches the live session before the next prompt", async () => {
    const home = makeTempHome();
    try {
      const { query, spawns } = stubQuery();
      const adapter = makeClaudeCodeAdapter({ claudePath: "claude.exe", query });
      await Effect.runPromise(Stream.runCollect(adapter.run(input(home, "one", U1))));
      const opusHigh: Route = { harness: "claude-code", model: "opus", effort: "high" };
      await Effect.runPromise(Stream.runCollect(adapter.run(input(home, "two", U2, "sess-1", Stream.empty, opusHigh))));
      await Effect.runPromise(Stream.runCollect(adapter.run(input(home, "three", U3, "sess-1", Stream.empty, opusHigh))));
      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.log).toEqual([
        "prompt one",
        "setModel opus",
        'applyFlagSettings {"effortLevel":"high"}',
        "prompt two",
        "prompt three",
      ]);
    } finally {
      removeTempHome(home);
    }
  });

  test("a mode change reaches the live session before the next prompt; build restores the user's own mode", async () => {
    const home = makeTempHome();
    try {
      const { query, spawns } = stubQuery(undefined, { ...init, permissionMode: "acceptEdits" } as SDKMessage);
      const adapter = makeClaudeCodeAdapter({ claudePath: "claude.exe", query });
      const turn = (text: string, turnId: string, mode: InteractionMode) =>
        Effect.runPromise(Stream.runCollect(adapter.run(input(home, text, turnId, "sess-1", Stream.empty, haikuLow, mode))));
      await Effect.runPromise(Stream.runCollect(adapter.run(input(home, "one", U1))));
      await turn("two", U2, "plan");
      await turn("three", U3, "ask");
      await turn("four", "00000000-0000-4000-8000-000000000004", "build");
      expect(spawns).toHaveLength(1);
      expect(spawns[0]?.options.permissionMode).toBeUndefined();
      expect(spawns[0]?.log).toEqual([
        "prompt one",
        "setPermissionMode plan",
        "prompt two",
        "prompt three",
        "setPermissionMode acceptEdits",
        "prompt four",
      ]);
    } finally {
      removeTempHome(home);
    }
  });

  test("ExitPlanMode asks for plan approval; a rejection's feedback keeps planning, approval leaves plan mode", async () => {
    const home = makeTempHome();
    try {
      const decisions: unknown[] = [];
      const { query, spawns } = stubQuery(async function* (prompt, options, m) {
        const exit = (plan: string) =>
          options.canUseTool?.(
            "ExitPlanMode",
            { plan, planFilePath: "C:/Users/a b/.claude/plans/p.md" },
            { signal: new AbortController().signal, toolUseID: "toolu_1", requestId: "c1" },
          );
        if (prompt === "plan it") decisions.push(await exit("v1"));
        else if (prompt === "smaller") {
          decisions.push(await exit("v2"));
          yield { ...result(turn1Usage), user_message_uuids: [m.uuid] } as SDKMessage;
        } else yield result(turn2Usage);
      });
      const adapter = makeClaudeCodeAdapter({ claudePath: "claude.exe", query });
      const plans: unknown[] = [];
      await Effect.runPromise(
        adapter.run(input(home, "plan it", U1, undefined, Stream.empty, haikuLow, "plan")).pipe(
          Stream.runForEach((e) => {
            if (e.type !== "plan.requested") return Effect.void;
            plans.push({ plan: e.plan, filePath: e.filePath });
            return adapter.respond(
              threadId,
              e.requestId,
              plans.length === 1 ? { decision: "deny", feedback: "smaller" } : { decision: "allow" },
            );
          }),
        ),
      );
      await Effect.runPromise(Stream.runCollect(adapter.run(input(home, "next", U2, "sess-1"))));
      expect(plans).toEqual([
        { plan: "v1", filePath: "C:/Users/a b/.claude/plans/p.md" },
        { plan: "v2", filePath: "C:/Users/a b/.claude/plans/p.md" },
      ]);
      expect(decisions).toEqual([
        { behavior: "deny", message: "The user denied this." },
        { behavior: "allow", updatedInput: { plan: "v2", planFilePath: "C:/Users/a b/.claude/plans/p.md" } },
      ]);
      expect(spawns[0]?.options.permissionMode).toBe("plan");
      expect(spawns[0]?.prompts[1]).toMatchObject({ message: { content: "smaller" }, priority: "next" });
      // The approval already left plan mode, so the build turn needs no switch.
      expect(spawns[0]?.log).toEqual(["prompt plan it", "prompt smaller", "prompt next"]);
    } finally {
      removeTempHome(home);
    }
  });

  test("a live session the thread is no longer bound to is replaced", async () => {
    const home = makeTempHome();
    try {
      const { query, spawns } = stubQuery();
      const adapter = makeClaudeCodeAdapter({ claudePath: "claude.exe", query });
      await Effect.runPromise(Stream.runCollect(adapter.run(input(home, "one", U1))));
      await Effect.runPromise(Stream.runCollect(adapter.run(input(home, "two", U2))));
      expect(spawns).toHaveLength(2);
      expect(spawns[1]?.options.resume).toBeUndefined();
    } finally {
      removeTempHome(home);
    }
  });

  test("an error result closes the session; the next turn resumes it", async () => {
    const home = makeTempHome();
    try {
      const { query, spawns } = stubQuery((p) =>
        p === "bad" ? [result(turn1Usage, "error_during_execution", ["boom"])] : [result(turn1Usage)],
      );
      const adapter = makeClaudeCodeAdapter({ claudePath: "claude.exe", query });
      const bad = await Effect.runPromise(Stream.runCollect(adapter.run(input(home, "bad", U1))));
      expect(Array.from(bad).at(-1)).toEqual({ type: "turn.finished", status: "error", error: "boom" });
      await Effect.runPromise(Stream.runCollect(adapter.run(input(home, "good", U2, "sess-1"))));
      expect(spawns).toHaveLength(2);
      expect(spawns[1]?.options.resume).toBe("sess-1");
    } finally {
      removeTempHome(home);
    }
  });

  test("an interrupted turn stops Claude Code; the next turn resumes the session in a fresh process", async () => {
    const home = makeTempHome();
    try {
      const { query, spawns } = stubQuery(async function* (prompt, _options, _m, interrupted) {
        if (prompt === "long") {
          yield textDelta("working");
          await interrupted;
          yield result(turn1Usage, "error_during_execution", ["interrupted"]);
        } else yield result(turn2Usage);
      });
      const adapter = makeClaudeCodeAdapter({ claudePath: "claude.exe", query });
      const working = Promise.withResolvers<void>();
      const running = Effect.runFork(
        adapter
          .run(input(home, "long", U1))
          .pipe(Stream.runForEach((e) => Effect.sync(() => e.type === "text.delta" && working.resolve()))),
      );
      await working.promise;
      await Effect.runPromise(Fiber.interrupt(running));
      expect(spawns[0]?.log).toEqual(["prompt long", "interrupt", "close"]);
      const next = Array.from(await Effect.runPromise(Stream.runCollect(adapter.run(input(home, "next", U2, "sess-1")))));
      expect(spawns).toHaveLength(2);
      expect(spawns[1]?.options.resume).toBe("sess-1");
      expect(next.at(-1)).toEqual({ type: "turn.finished", status: "success" });
    } finally {
      removeTempHome(home);
    }
  });

  test("a steer that misses the last tool boundary is answered inside the same turn", async () => {
    const home = makeTempHome();
    try {
      // The steer arrives after the model's last tool call, so Claude Code queues it: the first result
      // reports it pending, and a second result reports it consumed.
      const { query, spawns } = stubQuery((prompt, _options, m) =>
        prompt === "work"
          ? [assistant([{ type: "text", text: "working" }]), { ...result(turn1Usage), queued_turn_count: 1 } as SDKMessage]
          : [assistant([{ type: "text", text: `ok, ${prompt}` }]), { ...result(turn2Usage), user_message_uuids: [m.uuid] } as SDKMessage],
      );
      const adapter = makeClaudeCodeAdapter({ claudePath: "claude.exe", query });
      const events = Array.from(
        await Effect.runPromise(Stream.runCollect(adapter.run(input(home, "work", U1, undefined, Stream.make("go left"))))),
      );
      expect(events.filter((e) => e.type === "item").map((e) => e.item)).toEqual([
        { kind: "assistant.message", text: "working" },
        { kind: "assistant.message", text: "ok, go left" },
      ]);
      expect(events.filter((e) => e.type === "turn.finished")).toEqual([{ type: "turn.finished", status: "success" }]);
      const steer = spawns[0]?.prompts[1];
      expect(steer?.message.content).toBe("go left");
      expect(steer?.priority).toBeUndefined();
    } finally {
      removeTempHome(home);
    }
  });
});
