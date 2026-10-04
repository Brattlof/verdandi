/**
 * One scripted response of the fake Chat Completions endpoint. `reasoning` and `reasoningDetails` stream the fields
 * Ollama and OpenRouter send besides text (`reasoning_details` one element per chunk, pieces sharing an index, like
 * OpenRouter). `finish` defaults to `tool_calls` when the reply calls a tool, else `stop`. `hang` streams the reply,
 * then keeps the response open until the request is aborted. `error` answers with that HTTP status instead, with
 * `retryAfter` (seconds) when set.
 */
export type FakeChatReply =
  | {
      readonly text?: string;
      readonly reasoning?: string;
      readonly reasoningDetails?: readonly Record<string, unknown>[];
      readonly toolCalls?: readonly { readonly id: string; readonly name: string; readonly input: Record<string, unknown> }[];
      readonly finish?: "stop" | "tool_calls" | "length" | "content_filter";
      readonly usage?: { readonly prompt?: number; readonly completion?: number; readonly cached?: number };
      readonly hang?: boolean;
    }
  | { readonly error: { readonly status: number; readonly message: string; readonly retryAfter?: number } };

const encoder = new TextEncoder();

/** A reply as the chunks a Chat Completions stream sends, text and tool arguments split into pieces like a real one. */
const chunks = (reply: Exclude<FakeChatReply, { error: unknown }>, model: string) => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const out: Record<string, unknown>[] = [chunk({ role: "assistant", content: "" })];
  if (reply.reasoning) out.push(chunk({ reasoning: reply.reasoning }));
  for (const detail of reply.reasoningDetails ?? []) out.push(chunk({ reasoning_details: [detail] }));
  for (const piece of reply.text?.match(/[\s\S]{1,8}/g) ?? []) out.push(chunk({ content: piece }));
  (reply.toolCalls ?? []).forEach((call, index) => {
    const json = JSON.stringify(call.input);
    const half = Math.ceil(json.length / 2);
    out.push(
      chunk({ tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: json.slice(0, half) } }] }),
    );
    out.push(chunk({ tool_calls: [{ index, function: { arguments: json.slice(half) } }] }));
  });
  out.push(chunk({}, reply.finish ?? (reply.toolCalls?.length ? "tool_calls" : "stop")));
  const cached = reply.usage?.cached ?? 0;
  out.push({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [],
    usage: {
      prompt_tokens: reply.usage?.prompt ?? 100,
      completion_tokens: reply.usage?.completion ?? 20,
      total_tokens: (reply.usage?.prompt ?? 100) + (reply.usage?.completion ?? 20),
      ...(cached > 0 && { prompt_tokens_details: { cached_tokens: cached } }),
    },
  });
  return out;
};

/**
 * A fake OpenAI-compatible Chat Completions endpoint for tests: a `fetch` that answers each request with the next
 * scripted reply as a real server-sent event stream, so no test reaches the network. `requests` keeps each request's
 * URL, headers and body, in order; `arrived(n)` resolves once the `n`th (1-based) has come in. A request past the
 * script fails with a 500 that says so.
 */
export const makeFakeChatCompletions = (script: readonly FakeChatReply[]) => {
  const queue = [...script];
  const requests: { readonly url: string; readonly headers: Record<string, string>; readonly body: Record<string, unknown> }[] = [];
  const waiters: { n: number; resolve: () => void }[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    for (const w of waiters.filter((w) => w.n <= requests.length)) w.resolve();
    const reply = queue.shift();
    if (!reply || "error" in reply) {
      const error = reply?.error ?? { status: 500, message: `The fake endpoint has no reply scripted for request ${requests.length}.` };
      return new Response(JSON.stringify({ error: { message: error.message } }), {
        status: error.status,
        headers: { "content-type": "application/json", ...(error.retryAfter !== undefined && { "retry-after": String(error.retryAfter) }) },
      });
    }
    const signal = init?.signal ?? undefined;
    const frames = chunks(reply, String(body.model));
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const c of reply.hang ? frames.slice(0, -2) : frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
        if (!reply.hang) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          return controller.close();
        }
        if (!signal?.aborted) await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
        controller.error(new DOMException("The request was aborted.", "AbortError"));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const arrived = (n: number) => (requests.length >= n ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ n, resolve })));
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests, arrived };
};
