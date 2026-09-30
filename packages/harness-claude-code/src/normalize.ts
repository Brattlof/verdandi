import type { ModelUsage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessEvent, Item, Quota } from "@verdandi/contracts";

/** What normalizing carries from one message to the next within a session. */
export type NormalizeContext = {
  /** The last result's cumulative modelUsage: in a streaming session each result reports running totals. */
  readonly prevModelUsage: Readonly<Record<string, ModelUsage>>;
  /** Set by rate_limit_event: the plan window is used up and extra usage is paying (ADR 0005). */
  readonly overage: boolean;
  /** The last quota reported, so an unchanged window isn't reported again. */
  readonly quota: Quota | undefined;
};

export const initialContext = (): NormalizeContext => ({ prevModelUsage: {}, overage: false, quota: undefined });

type Block = { readonly type: string; readonly [k: string]: unknown };

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: Block) => (b.type === "text" ? String(b.text) : `[${b.type}]`)).join("\n");
  return "";
};

const usageEvents = (context: NormalizeContext, modelUsage: Record<string, ModelUsage>): HarnessEvent[] =>
  Object.entries(modelUsage).flatMap(([model, now]): HarnessEvent[] => {
    const before = context.prevModelUsage[model];
    const delta = (k: keyof ModelUsage) => (now[k] as number) - ((before?.[k] as number | undefined) ?? 0);
    const usage = {
      inputTokens: delta("inputTokens"),
      outputTokens: delta("outputTokens"),
      cacheReadTokens: delta("cacheReadInputTokens"),
      cacheWriteTokens: delta("cacheCreationInputTokens"),
      costUsd: delta("costUSD"),
    };
    if (Object.values(usage).every((v) => v === 0)) return [];
    return [{ type: "usage", model, accessMode: context.overage ? "metered" : "subscription", ...usage }];
  });

/**
 * Pure: one SDK message in, Verdandi harness events out. A subagent's messages (non-null
 * `parent_tool_use_id`) become items tagged with that tool call; its text deltas aren't streamed.
 */
export const normalize = (msg: SDKMessage, context: NormalizeContext): { events: HarnessEvent[]; context: NormalizeContext } => {
  const none = { events: [], context };
  const parent = "parent_tool_use_id" in msg && msg.parent_tool_use_id !== null ? { parentToolUseId: msg.parent_tool_use_id } : undefined;
  const itemEvents = (items: Item[]): HarnessEvent[] =>
    items.map((item) => ({ type: "item", item: parent ? { ...item, ...parent } : item }));
  switch (msg.type) {
    case "system":
      return msg.subtype === "init"
        ? { events: [{ type: "session.started", sessionId: msg.session_id, harnessVersion: msg.claude_code_version }], context }
        : none;
    case "stream_event": {
      if (parent) return none;
      const e = msg.event as { type: string; delta?: { type: string; text?: string } };
      return e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text
        ? { events: [{ type: "text.delta", text: e.delta.text }], context }
        : none;
    }
    case "assistant": {
      const items = (msg.message.content as unknown as Block[]).flatMap((b): Item[] => {
        if (b.type === "text") return [{ kind: "assistant.message", text: String(b.text) }];
        if (b.type === "tool_use") return [{ kind: "tool.call", toolUseId: String(b.id), name: String(b.name), input: b.input }];
        return [];
      });
      return { events: itemEvents(items), context };
    }
    case "user": {
      const content = msg.message.content;
      if (!Array.isArray(content)) return none;
      const items = (content as unknown as Block[]).flatMap((b): Item[] =>
        b.type === "tool_result"
          ? [{ kind: "tool.result", toolUseId: String(b.tool_use_id), isError: b.is_error === true, content: textOf(b.content) }]
          : [],
      );
      return { events: itemEvents(items), context };
    }
    case "rate_limit_event": {
      const info = msg.rate_limit_info;
      const quota: Quota = {
        status: info.status,
        ...(info.rateLimitType === undefined ? {} : { window: info.rateLimitType }),
        // Whole percent: finer changes aren't worth an event each.
        ...(info.utilization === undefined ? {} : { utilization: Math.round(info.utilization * 100) / 100 }),
        ...(info.resetsAt === undefined ? {} : { resetsAt: new Date(info.resetsAt * 1000).toISOString() }), // epoch seconds
        usingOverage: info.isUsingOverage === true,
      };
      const changed = JSON.stringify(quota) !== JSON.stringify(context.quota);
      return {
        events: changed ? [{ type: "quota", quota }] : [],
        context: { ...context, overage: info.isUsingOverage === true || info.status === "rejected", quota },
      };
    }
    case "result": {
      const finished: HarnessEvent =
        msg.subtype === "success" && !msg.is_error
          ? { type: "turn.finished", status: "success" }
          : {
              type: "turn.finished",
              status: "error",
              error: ("errors" in msg && msg.errors.join("\n")) || `Claude Code ended the turn with ${msg.subtype}.`,
            };
      return {
        events: [...usageEvents(context, msg.modelUsage), finished],
        context: { ...context, prevModelUsage: msg.modelUsage },
      };
    }
    default:
      return none;
  }
};
