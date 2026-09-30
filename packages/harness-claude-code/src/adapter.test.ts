import { describe, expect, test } from "bun:test";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessRunInput, ThreadId, TurnId } from "@verdandi/contracts";
import { makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, Stream } from "effect";
import { makeClaudeCodeAdapter, type QueryFn } from "./adapter.ts";
import { assistant, init, result, textDelta, turn1Usage, turn2Usage } from "./fixtures.ts";

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";

/** A fake SDK `query`: answers each prompt with a delta and a result; records what it was given. */
const stubQuery = (
  script: (prompt: string, options: Options, message: SDKUserMessage) => SDKMessage[] | AsyncIterable<SDKMessage> = () => [
    textDelta("ok"),
    result(turn1Usage),
  ],
) => {
  const spawns: { options: Options; prompts: SDKUserMessage[] }[] = [];
  const query = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const record = { options: params.options, prompts: [] as SDKUserMessage[] };
    spawns.push(record);
    return (async function* () {
      yield init;
      for await (const m of params.prompt) {
        record.prompts.push(m);
        yield* script(String(m.message.content), params.options, m);
      }
    })();
  }) as unknown as QueryFn;
  return { query, spawns };
};

const threadId = "thread-1" as ThreadId;

const input = (
  cwd: string,
  text: string,
  turnId: string,
  resumeSessionId?: string,
  steers: Stream.Stream<string> = Stream.empty,
): HarnessRunInput => ({
  threadId,
  cwd,
  route: { harness: "claude-code", model: "haiku", effort: "low" },
  resumeSessionId,
  turnId: turnId as TurnId,
  text,
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
      const second = await Effect.runPromise(Stream.runCollect(adapter.run(input(home, "two", U2))));
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
