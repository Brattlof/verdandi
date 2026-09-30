import { describe, expect, test } from "bun:test";
import { assistant, init, rateLimit, result, textDelta, toolResult, turn1Usage, turn2Usage } from "./fixtures.ts";
import { initialContext, normalize } from "./normalize.ts";

const events = (msg: Parameters<typeof normalize>[0], ctx = initialContext()) => normalize(msg, ctx).events;

describe("normalize", () => {
  test("init starts the session with the Claude Code version", () => {
    expect(events(init)).toEqual([{ type: "session.started", sessionId: "sess-1", harnessVersion: "2.1.284" }]);
  });

  test("main-thread text deltas stream; subagent deltas don't", () => {
    expect(events(textDelta("Hel"))).toEqual([{ type: "text.delta", text: "Hel" }]);
    expect(events(textDelta("sub", "toolu_1"))).toEqual([]);
  });

  test("assistant text and tool calls become items", () => {
    const msg = assistant([
      { type: "text", text: "Reading it." },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } },
    ]);
    expect(events(msg)).toEqual([
      { type: "item", item: { kind: "assistant.message", text: "Reading it." } },
      { type: "item", item: { kind: "tool.call", toolUseId: "toolu_1", name: "Read", input: { file_path: "a.ts" } } },
    ]);
  });

  test("tool results become items with their text", () => {
    expect(events(toolResult("toolu_1", [{ type: "text", text: "line 1" }], true))).toEqual([
      { type: "item", item: { kind: "tool.result", toolUseId: "toolu_1", isError: true, content: "line 1" } },
    ]);
    expect(events(toolResult("toolu_2", "plain"))).toEqual([
      { type: "item", item: { kind: "tool.result", toolUseId: "toolu_2", isError: false, content: "plain" } },
    ]);
  });

  test("a subagent's steps become items tagged with the tool call that started it", () => {
    const call = assistant([{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "a.ts" } }], "toolu_1");
    expect(events(call)).toEqual([
      {
        type: "item",
        item: { kind: "tool.call", toolUseId: "toolu_2", name: "Read", input: { file_path: "a.ts" }, parentToolUseId: "toolu_1" },
      },
    ]);
    expect(events(toolResult("toolu_2", "x", false, "toolu_1"))).toEqual([
      { type: "item", item: { kind: "tool.result", toolUseId: "toolu_2", isError: false, content: "x", parentToolUseId: "toolu_1" } },
    ]);
    expect(events(assistant([{ type: "text", text: "Done." }], "toolu_1"))).toEqual([
      { type: "item", item: { kind: "assistant.message", text: "Done.", parentToolUseId: "toolu_1" } },
    ]);
  });

  test("usage is per turn, including auxiliary models", () => {
    const first = normalize(result(turn1Usage), initialContext());
    const second = normalize(result(turn2Usage), first.context);
    const usage = second.events.filter((e) => e.type === "usage");
    expect(usage).toEqual([
      {
        type: "usage",
        model: "claude-sonnet-5-5",
        accessMode: "subscription",
        inputTokens: 2,
        outputTokens: 50,
        cacheReadTokens: 18000,
        cacheWriteTokens: 100,
        costUsd: expect.closeTo(0.03, 10) as unknown as number,
      },
    ]);
    expect(second.events.at(-1)).toEqual({ type: "turn.finished", status: "success" });
    expect(first.events.filter((e) => e.type === "usage").map((e) => e.type === "usage" && e.model)).toEqual([
      "claude-sonnet-5-5",
      "claude-haiku-4-5-20251001",
    ]);
  });

  test("marks usage metered while using overage", () => {
    const after = normalize(rateLimit({ status: "rejected", isUsingOverage: true }), initialContext()).context;
    const usage = normalize(result(turn1Usage), after).events.find((e) => e.type === "usage");
    expect(usage?.type === "usage" && usage.accessMode).toBe("metered");
  });

  test("reports the subscription window once per change", () => {
    const warning = rateLimit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.8123, resetsAt: 1790780400 });
    const first = normalize(warning, initialContext());
    expect(first.events).toEqual([
      {
        type: "quota",
        quota: {
          status: "allowed_warning",
          window: "five_hour",
          utilization: 0.81,
          resetsAt: "2026-09-30T15:00:00.000Z",
          usingOverage: false,
        },
      },
    ]);
    expect(normalize(warning, first.context).events).toEqual([]);
    const overage = normalize(rateLimit({ status: "rejected", isUsingOverage: true }), first.context).events;
    expect(overage).toEqual([{ type: "quota", quota: { status: "rejected", usingOverage: true } }]);
  });

  test("error results finish the turn with the SDK's error text", () => {
    expect(events(result(turn1Usage, "error_during_execution", ["API overloaded"])).at(-1)).toEqual({
      type: "turn.finished",
      status: "error",
      error: "API overloaded",
    });
  });

  test("a budget guard's result finishes the turn at its limit, saying which guard", () => {
    expect(events(result(turn1Usage, "error_max_turns", ["Reached maximum number of turns (1)"])).at(-1)).toEqual({
      type: "turn.finished",
      status: "limit",
      error: "Stopped at the task's turn limit (maxTurns in the routing policy).",
    });
    expect(events(result(turn1Usage, "error_max_budget_usd")).at(-1)).toMatchObject({ status: "limit" });
  });
});
