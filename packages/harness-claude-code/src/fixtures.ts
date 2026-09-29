import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

// Minimal SDK messages with only the fields Verdandi reads. Full SDK types carry dozens of
// unrelated required fields, so these are cast; keep them in step with the pinned sdk.d.ts.
const sdk = (m: object) => m as unknown as SDKMessage;

export const init = sdk({
  type: "system",
  subtype: "init",
  session_id: "sess-1",
  claude_code_version: "2.1.284",
  model: "claude-sonnet-5-5",
});

export const textDelta = (text: string, parent: string | null = null) =>
  sdk({
    type: "stream_event",
    parent_tool_use_id: parent,
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  });

export const assistant = (content: object[], parent: string | null = null) =>
  sdk({ type: "assistant", parent_tool_use_id: parent, message: { role: "assistant", content } });

export const toolResult = (tool_use_id: string, content: unknown, is_error = false) =>
  sdk({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id, content, is_error }] },
  });

export const rateLimit = (info: object) => sdk({ type: "rate_limit_event", rate_limit_info: info });

const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: cacheRead,
  cacheCreationInputTokens: cacheWrite,
  webSearchRequests: 0,
  costUSD: cost,
  contextWindow: 200000,
  maxOutputTokens: 32000,
});

/** Cumulative modelUsage, as the SDK reports it in a streaming session. */
export const result = (modelUsage: Record<string, ReturnType<typeof usage>>, subtype = "success", errors: string[] = []) =>
  sdk({ type: "result", subtype, is_error: subtype !== "success", result: "done", errors, modelUsage, total_cost_usd: 0 });

export const turn1Usage = {
  "claude-sonnet-5-5": usage(10, 100, 15000, 3000, 0.02),
  "claude-haiku-4-5-20251001": usage(900, 12, 0, 0, 0.001),
};
export const turn2Usage = {
  "claude-sonnet-5-5": usage(12, 150, 33000, 3100, 0.05),
  "claude-haiku-4-5-20251001": usage(900, 12, 0, 0, 0.001),
};
