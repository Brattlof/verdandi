import Anthropic from "@anthropic-ai/sdk";
import { VERSION } from "@anthropic-ai/sdk/version";
import { HarnessError } from "@verdandi/contracts";
import { fingerprint } from "./cache-check.ts";
import type { Provider, ProviderReply } from "./provider.ts";
import { classify } from "./provider-failure.ts";
import type { ToolSearch } from "./tool-search.ts";
import { type EffortMessage, type Message, requestMessages } from "./transcript.ts";

/** The beta that takes an effort-only system message within a conversation (ADR 0022). */
const perMessageEffort = "mid-conversation-output-config-2026-07-01";

/** What each HTTP status that isn't a provider failure (`classify`) means for the user, and the fix. */
const statusFailures: Record<number, string> = {
  400: "The Anthropic API refused the request.",
  403: "The API key isn't allowed to do this, e.g. use this model. Check its workspace's permissions in the Anthropic Console, or pick another route.",
};

const failure = (error: unknown) => {
  if (error instanceof Anthropic.APIConnectionError)
    return new HarnessError({ message: `Couldn't reach the Anthropic API (${error.message}). Check the network, then try again.` });
  if (error instanceof Anthropic.APIError && error.status !== undefined) {
    const known =
      statusFailures[error.status] ??
      (error.status >= 500
        ? "The Anthropic API failed. Try again shortly, or pick a Claude Code route."
        : "The Anthropic API refused the request.");
    return new HarnessError({ message: `${known} (${error.message})` });
  }
  return undefined;
};

/** A message as the Messages API takes it: blocks other providers carried stay behind. */
const sendable = (m: Message | EffortMessage) =>
  (m.role === "system"
    ? m
    : { role: m.role, content: m.content.flatMap((b) => (b.type === "carried" ? [] : [b])) }) as Anthropic.MessageParam;

/**
 * The Anthropic Messages API through `@anthropic-ai/sdk` (ADR 0022), metered. A turn's own effort goes as an effort
 * message under its beta. Tests pass the fake provider's `fetch`.
 */
export const anthropicProvider = (apiKey: string, fetch?: typeof globalThis.fetch, toolSearch: ToolSearch = "server"): Provider => {
  // Everything explicit, so nothing in the environment meant for Claude Code (a base URL, a token, debug logging) applies here.
  const client = new Anthropic({
    apiKey,
    authToken: null,
    baseURL: "https://api.anthropic.com",
    logLevel: "warn",
    ...(fetch && { fetch }),
  });
  return {
    id: "anthropic",
    toolSearch,
    version: `@anthropic-ai/sdk ${VERSION}`,
    classify,
    fix: (reason) =>
      reason === "auth"
        ? "Replace it with `verdandi key set anthropic` (or VERDANDI_ANTHROPIC_API_KEY), then restart verdandid."
        : undefined,
    failure,
    async *send({ route, entry, prefix, entries, compressions, maxTokens, signal, check }) {
      const efforts = entry.efforts.length > 0;
      const body: Anthropic.MessageCreateParamsNonStreaming = {
        model: route.model,
        max_tokens: maxTokens,
        system: prefix.system,
        tools: prefix.tools,
        // The second breakpoint moves along with the conversation; the first ends the fixed prefix.
        cache_control: { type: "ephemeral" },
        messages: requestMessages(entries, efforts, compressions.at(-1), (b) => b.type !== "carried").map(sendable),
        // A model without effort levels (Haiku 4.5) takes neither effort nor adaptive thinking.
        ...(efforts ? { thinking: { type: "adaptive" as const }, output_config: { effort: route.effort } } : {}),
      };
      check(fingerprint(route, body, compressions.length));
      const perTurn = body.messages.some((m) => m.role === "system");
      const stream = client.messages.stream(body, { signal, ...(perTurn && { headers: { "anthropic-beta": perMessageEffort } }) });
      for await (const event of stream)
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield event.delta.text;
      const reply = await stream.finalMessage();
      const stop: ProviderReply["stop"] =
        reply.stop_reason === "refusal" ||
        reply.stop_reason === "max_tokens" ||
        reply.stop_reason === "tool_use" ||
        reply.stop_reason === "pause_turn"
          ? reply.stop_reason
          : "end_turn";
      return {
        // Whole and unchanged, thinking blocks included: they go back to the model exactly as it sent them.
        content: reply.content as Anthropic.ContentBlockParam[],
        stop,
        ...(reply.stop_details?.category && { refusal: reply.stop_details.category }),
        tokens: {
          inputTokens: reply.usage.input_tokens,
          outputTokens: reply.usage.output_tokens,
          cacheReadTokens: reply.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: reply.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
};
