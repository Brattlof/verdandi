import { describe, expect, test } from "bun:test";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessRunInput, ThreadId, TurnId } from "@verdandi/contracts";
import { makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, Stream } from "effect";
import { makeClaudeCodeAdapter, type QueryFn } from "./adapter.ts";
import { init, result, textDelta, turn1Usage } from "./fixtures.ts";

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";

/** A fake SDK `query`: answers each prompt with a delta and a result; records what it was given. */
const stubQuery = (script: (prompt: string) => SDKMessage[] = () => [textDelta("ok"), result(turn1Usage)]) => {
  const spawns: { options: Options; prompts: SDKUserMessage[] }[] = [];
  const query = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const record = { options: params.options, prompts: [] as SDKUserMessage[] };
    spawns.push(record);
    return (async function* () {
      yield init;
      for await (const m of params.prompt) {
        record.prompts.push(m);
        yield* script(String(m.message.content));
      }
    })();
  }) as unknown as QueryFn;
  return { query, spawns };
};

const input = (cwd: string, text: string, turnId: string, resumeSessionId?: string): HarnessRunInput => ({
  threadId: "thread-1" as ThreadId,
  cwd,
  route: { harness: "claude-code", model: "haiku", effort: "low" },
  resumeSessionId,
  turnId: turnId as TurnId,
  text,
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
      await Effect.runPromise(Stream.runCollect(adapter.run(input(home, "two", U2))));
      expect(Array.from(first).map((e) => e.type)).toEqual(["session.started", "text.delta", "usage", "usage", "turn.finished"]);
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
});
