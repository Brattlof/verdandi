import type Anthropic from "@anthropic-ai/sdk";
import { type CatalogEntry, HarnessError, type Route } from "@verdandi/contracts";
import { hash, type Sent } from "./cache-check.ts";
import type { Provider, ProviderReply } from "./provider.ts";
import { failureOf, statusFailure } from "./provider-failure.ts";
import { type Block, type CarriedBlock, type EffortMessage, type Message, type Prefix, requestMessages } from "./transcript.ts";

/** An OpenAI-compatible endpoint the user configured (ADR 0035): Ollama, LM Studio, vLLM, OpenRouter and others. */
export type Endpoint = {
  /** The catalog's `provider` for its models, e.g. `ollama`. */
  readonly id: string;
  /** Its base URL, e.g. `http://127.0.0.1:11434/v1`; requests go to `<url>/chat/completions`. */
  readonly url: string;
  /** Sent as a bearer token when there is one; a local server needs none. Never logged. */
  readonly key: string | undefined;
  /** Its models as the router sees them: `harness: "native"`, `provider: id`. */
  readonly models: readonly CatalogEntry[];
};

type ChatMessage = Record<string, unknown> & { readonly role: string };
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

/** Where the endpoint's reply streams in, accumulated: text, tool calls by index, and every other field it sent. */
type Assembled = { content: string; refusal: string; toolCalls: ToolCall[]; extra: Record<string, unknown> };

/** An error the endpoint answered with, or one reaching it; `status` is undefined when it couldn't be reached. */
export class EndpointError extends Error {
  constructor(
    readonly endpoint: string,
    readonly status: number | undefined,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

const retried = (status: number) => status === 408 || status === 409 || status === 429 || status >= 500;
const maxRetries = 2;

const textOf = (content: Anthropic.ToolResultBlockParam["content"]) =>
  typeof content === "string" ? content : (content ?? []).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");

/**
 * The session's fixed prefix as Chat Completions takes it: one system message and the tools as functions. A session
 * that opened on the Anthropic API with server tool search keeps its tool list; here the API's search tool stays behind
 * and the tools it deferred go in full, since an endpoint has no `defer_loading` (DESIGN §9.4).
 */
const prefixOf = (prefix: Prefix) => ({
  system: { role: "system", content: prefix.system.map((b) => b.text).join("\n\n") } satisfies ChatMessage,
  tools: prefix.tools
    .flatMap((t) => ("input_schema" in t ? [t] : []))
    .map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    })),
});

/**
 * A session's messages as Chat Completions takes them. An assistant message's text, tool calls and the fields this
 * endpoint sent (its carried block) go back together; a user message's tool results become `tool` messages first, then
 * its text and images. Thinking blocks and effort messages are the Messages API's and stay behind.
 */
const messagesOf = (messages: readonly (Message | EffortMessage)[]): ChatMessage[] =>
  messages.flatMap((m): ChatMessage[] => {
    if (m.role === "system") return [];
    const texts = m.content.flatMap((b) => (b.type === "text" ? [b.text] : []));
    if (m.role === "assistant") {
      const calls = m.content.flatMap((b) =>
        b.type === "tool_use" ? [{ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } }] : [],
      );
      const carried = m.content.flatMap((b) => (b.type === "carried" ? [b.value] : []));
      return [
        {
          role: "assistant",
          content: texts.length > 0 ? texts.join("") : null,
          ...(calls.length > 0 && { tool_calls: calls }),
          ...Object.assign({}, ...carried),
        },
      ];
    }
    const results = m.content.flatMap((b) =>
      b.type === "tool_result"
        ? [{ role: "tool", tool_call_id: b.tool_use_id, content: `${b.is_error ? "Error: " : ""}${textOf(b.content)}` }]
        : [],
    );
    const images = m.content.flatMap((b) =>
      b.type === "image" && b.source.type === "base64"
        ? [{ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }]
        : [],
    );
    const user =
      texts.length === 0 && images.length === 0
        ? []
        : [
            images.length === 0
              ? { role: "user", content: texts.join("\n\n") }
              : { role: "user", content: [...texts.map((text) => ({ type: "text", text })), ...images] },
          ];
    return [...results, ...user];
  });

/** A request's fingerprint, in the shape the Messages API's has: one block per message (ADR 0022). */
const fingerprintOf = (
  route: Route,
  body: { model: string; messages: ChatMessage[]; tools: unknown; reasoning_effort?: string },
  compressions: number,
): Sent => ({
  route,
  compressions,
  system: hash(body.messages[0]),
  tools: hash(body.tools),
  params: { model: body.model, thinking: "null", effort: JSON.stringify(body.reasoning_effort ?? null) },
  blocks: body.messages.slice(1).map((m, i) => ({ hash: hash(m), message: i + 1, block: 1 })),
});

/** The data payloads of a server-sent event stream, parsed, until `[DONE]`. Comments (OpenRouter's keepalives) are skipped. */
async function* events(body: ReadableStream<Uint8Array>, endpoint: string): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    for (let end = buffer.search(/\r?\n\r?\n/); end >= 0; end = buffer.search(/\r?\n\r?\n/)) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
      const data = event
        .split(/\r?\n/)
        .flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trimStart()] : []))
        .join("\n");
      if (data === "") continue;
      if (data === "[DONE]") return;
      try {
        yield JSON.parse(data);
      } catch {
        throw new EndpointError(endpoint, 200, `it streamed something that isn't JSON: ${data.slice(0, 200)}`);
      }
    }
  }
}

/**
 * Adds a delta's array to what came before. Elements with an `index` (OpenRouter's `reasoning_details`) are one
 * element streamed in pieces: their text joins and their other fields are set, so it ends as the provider would have
 * sent it whole.
 */
const mergeArray = (before: unknown, pieces: unknown[]) => {
  const out = Array.isArray(before) ? [...before] : [];
  for (const piece of pieces) {
    const at = typeof piece === "object" && piece !== null && "index" in piece ? out.findIndex((e) => e?.index === piece.index) : -1;
    if (at < 0) {
      out.push(piece);
      continue;
    }
    const merged = { ...out[at] };
    for (const [k, v] of Object.entries(piece as Record<string, unknown>))
      merged[k] = typeof v === "string" && typeof merged[k] === "string" && k !== "type" && k !== "format" ? merged[k] + v : v;
    out[at] = merged;
  }
  return out;
};

const accumulate = (into: Assembled, delta: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(delta)) {
    if (v === null || v === undefined || k === "role") continue;
    if (k === "content" && typeof v === "string") into.content += v;
    else if (k === "refusal" && typeof v === "string") into.refusal += v;
    else if (k === "tool_calls" && Array.isArray(v))
      for (const call of v as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
        const at = call.index ?? into.toolCalls.length;
        into.toolCalls[at] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
        const c = into.toolCalls[at];
        if (call.id) c.id = call.id;
        if (call.function?.name) c.function.name += call.function.name;
        if (call.function?.arguments) c.function.arguments += call.function.arguments;
      }
    else if (typeof v === "string") into.extra[k] = `${typeof into.extra[k] === "string" ? into.extra[k] : ""}${v}`;
    else if (Array.isArray(v)) into.extra[k] = mergeArray(into.extra[k], v);
    else into.extra[k] = v;
  }
};

/** Tool arguments as an object. ponytail: arguments that aren't a JSON object become `{}`, and the tool says what's missing; upgrade to an error result quoting them if small models trip on it. */
const argumentsOf = (text: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(text === "" ? "{}" : text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const stops: Record<string, ProviderReply["stop"]> = { length: "max_tokens", content_filter: "refusal" };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const errorMessage = async (response: Response) => {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const message = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? parsed.message);
    if (message) return message;
  } catch {}
  return text.slice(0, 300) || response.statusText;
};

/**
 * Any OpenAI-compatible Chat Completions endpoint, on plain `fetch` (ADR 0035): streams with usage, retries 408, 409,
 * 429 and 5xx twice with backoff (honouring `retry-after`) before the reply starts, and carries what the endpoint
 * sends besides text and tool calls (`reasoning`, `reasoning_details`) back to it unchanged. Its models' effort goes
 * as `reasoning_effort` when the catalog lists efforts for them. Reads nothing from the environment. Tests pass a fake
 * endpoint's `fetch`.
 */
export const chatCompletionsProvider = (endpoint: Endpoint, fetch: typeof globalThis.fetch = globalThis.fetch): Provider => {
  const sends = (b: Block) => (b.type === "carried" ? b.provider === endpoint.id : b.type !== "thinking" && b.type !== "redacted_thinking");
  const url = `${endpoint.url.replace(/\/+$/, "")}/chat/completions`;

  const post = async (body: string, signal: AbortSignal) => {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(endpoint.key && { authorization: `Bearer ${endpoint.key}` }) },
          body,
          signal,
        });
      } catch (e) {
        if (signal.aborted) throw e;
        throw new EndpointError(endpoint.id, undefined, e instanceof Error ? e.message : String(e));
      }
      if (response.ok) return response;
      const after = Number(response.headers.get("retry-after"));
      const retryAfterMs = Number.isFinite(after) && after >= 0 ? after * 1000 : undefined;
      if (attempt >= maxRetries || !retried(response.status))
        throw new EndpointError(endpoint.id, response.status, await errorMessage(response), retryAfterMs);
      await response.body?.cancel();
      await sleep(Math.min(retryAfterMs ?? 500 * 2 ** attempt, 60_000), signal);
      if (signal.aborted) throw new DOMException("The request was aborted.", "AbortError");
    }
  };

  return {
    id: endpoint.id,
    version: "chat completions",
    classify: (error, model) => {
      if (!(error instanceof EndpointError) || error.endpoint !== endpoint.id) return undefined;
      const found = statusFailure(error.status, error.message);
      const now = Date.now();
      return (
        found &&
        failureOf(
          found,
          model,
          error.retryAfterMs === undefined ? undefined : now + error.retryAfterMs,
          `${error.status} ${error.message}`,
          now,
        )
      );
    },
    fix: (reason) =>
      reason === "auth"
        ? `Replace it with \`verdandi key set ${endpoint.id}\`, then restart verdandid.`
        : reason === "model_not_found"
          ? `Check the model's name in providers.yaml (for Ollama, \`ollama pull\` it first).`
          : undefined,
    failure: (error) => (error instanceof EndpointError && error.endpoint === endpoint.id ? endpointFailure(endpoint, error) : undefined),
    async *send({ route, entry, prefix, entries, compressions, signal, check }) {
      const fixed = prefixOf(prefix);
      const body = {
        model: route.model,
        // Effort goes only as `reasoning_effort`, a request parameter, so a turn's own effort would break the cache: auto
        // effort leaves endpoint models alone (`decideTurnEffort`), and the route's effort holds.
        messages: [fixed.system, ...messagesOf(requestMessages(entries, false, compressions.at(-1), sends))],
        tools: fixed.tools,
        stream: true,
        stream_options: { include_usage: true },
        // ponytail: no max_tokens, since endpoints cap output differently and some refuse a cap above their own; a reply cut short ends the turn saying so.
        ...(entry.efforts.length > 0 && { reasoning_effort: route.effort }),
      };
      check(fingerprintOf(route, body, compressions.length));
      const response = await post(JSON.stringify(body), signal);
      if (!response.body) throw new EndpointError(endpoint.id, response.status, "it answered with no body.");
      const reply: Assembled = { content: "", refusal: "", toolCalls: [], extra: {} };
      let finish: string | undefined;
      let usage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
      for await (const chunk of events(response.body, endpoint.id)) {
        if (chunk.error) {
          const e = chunk.error as { message?: string; code?: number | string };
          throw new EndpointError(endpoint.id, typeof e.code === "number" ? e.code : 500, e.message ?? JSON.stringify(e));
        }
        if (chunk.usage) usage = chunk.usage as typeof usage;
        const choice = (chunk.choices as { delta?: Record<string, unknown>; finish_reason?: string | null }[] | undefined)?.[0];
        if (!choice) continue;
        if (typeof choice.delta?.content === "string" && choice.delta.content !== "") yield choice.delta.content;
        accumulate(reply, choice.delta ?? {});
        finish = choice.finish_reason ?? finish;
      }
      if (finish === undefined) throw new EndpointError(endpoint.id, 200, "it stopped streaming before the reply finished.");
      const calls = reply.toolCalls.filter(Boolean);
      const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const carried: CarriedBlock[] =
        Object.keys(reply.extra).length > 0 ? [{ type: "carried", provider: endpoint.id, value: reply.extra }] : [];
      return {
        content: [
          ...carried,
          ...(reply.content === "" ? [] : [{ type: "text" as const, text: reply.content }]),
          ...calls.map((c, i) => ({
            type: "tool_use" as const,
            id: c.id || `call_${i}_${crypto.randomUUID().slice(0, 8)}`,
            name: c.function.name,
            input: argumentsOf(c.function.arguments),
          })),
        ],
        // Some servers say `stop` after tool calls; the calls decide.
        stop: calls.length > 0 ? "tool_use" : reply.refusal !== "" ? "refusal" : (stops[finish] ?? "end_turn"),
        ...(reply.refusal !== "" && { refusal: reply.refusal }),
        tokens: {
          inputTokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
          outputTokens: usage?.completion_tokens ?? 0,
          cacheReadTokens: cached,
          cacheWriteTokens: 0,
        },
      };
    },
  };
};

/**
 * What an endpoint's error that isn't a provider failure (`classify`) means for the user, and the fix: it can't be reached,
 * it refused the request, or it broke off. Never holds the key.
 */
const endpointFailure = (endpoint: Endpoint, error: EndpointError) => {
  const name = `${endpoint.id} (${endpoint.url})`;
  const known =
    error.status === undefined
      ? `Couldn't reach ${name}. Check that it's running and the URL in providers.yaml, then try again.`
      : error.status === 403
        ? `${name} refused the API key for this. Check the key's permissions, or pick another route.`
        : error.status === 200
          ? `${name} failed. Try again shortly, or pick another route.`
          : `${name} refused the request.`;
  return new HarnessError({ message: `${known} (${error.message})` });
};
