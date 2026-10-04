/**
 * One content block of a scripted reply. `server` sends `block` whole, as a server tool's block arrives (e.g.
 * `server_tool_use` or `tool_search_tool_result`).
 */
export type FakeBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "server"; readonly block: { readonly type: string } & Record<string, unknown> }
  | { readonly type: "thinking"; readonly thinking: string; readonly signature: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: Record<string, unknown> };

/**
 * One scripted response of the fake Anthropic API. `stop` defaults to `tool_use` when a block calls a tool, else
 * `end_turn`. `hang` streams the blocks, then keeps the response open until the request is aborted. `error` answers
 * with that HTTP status instead, and `headers`, e.g. `retry-after-ms: 1` to make the SDK's retries quick.
 */
export type FakeReply =
  | {
      readonly blocks: readonly FakeBlock[];
      readonly stop?: "end_turn" | "tool_use" | "max_tokens" | "refusal";
      readonly usage?: { readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheWrite?: number };
      readonly hang?: boolean;
    }
  | {
      readonly error: { readonly status: number; readonly type: string; readonly message: string };
      readonly headers?: Readonly<Record<string, string>>;
    };

const encoder = new TextEncoder();
const frame = (data: { readonly type: string }) => encoder.encode(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);

/** A reply as the server-sent events the Messages API streams, text and tool input split into pieces like the real one. */
const events = (reply: Extract<FakeReply, { blocks: unknown }>, model: string) => {
  const usage = {
    input_tokens: reply.usage?.input ?? 100,
    output_tokens: reply.usage?.output ?? 20,
    cache_read_input_tokens: reply.usage?.cacheRead ?? 0,
    cache_creation_input_tokens: reply.usage?.cacheWrite ?? 0,
  };
  const stop = reply.stop ?? (reply.blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
  const out: { type: string }[] = [
    {
      type: "message_start",
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 1 },
      },
    } as { type: string },
  ];
  reply.blocks.forEach((b, index) => {
    const delta = (d: Record<string, unknown>) => out.push({ type: "content_block_delta", index, delta: d } as { type: string });
    if (b.type === "text") {
      out.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } } as { type: string });
      for (const piece of b.text.match(/[\s\S]{1,8}/g) ?? []) delta({ type: "text_delta", text: piece });
    } else if (b.type === "thinking") {
      out.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } } as {
        type: string;
      });
      delta({ type: "thinking_delta", thinking: b.thinking });
      delta({ type: "signature_delta", signature: b.signature });
    } else if (b.type === "server") {
      out.push({ type: "content_block_start", index, content_block: b.block } as { type: string });
    } else {
      out.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } } as {
        type: string;
      });
      const json = JSON.stringify(b.input);
      const half = Math.ceil(json.length / 2);
      delta({ type: "input_json_delta", partial_json: json.slice(0, half) });
      delta({ type: "input_json_delta", partial_json: json.slice(half) });
    }
    out.push({ type: "content_block_stop", index } as { type: string });
  });
  out.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } } as {
    type: string;
  });
  out.push({ type: "message_stop" });
  return out;
};

/**
 * A fake Anthropic Messages API for tests: a `fetch` to hand the SDK client, which answers each request with the next
 * scripted reply as a real server-sent event stream, so no test reaches the network. `requests` keeps each request's
 * body, headers and signal, in order; `arrived(n)` resolves once the `n`th request (1-based) has come in. A request past the
 * script fails the test with a 500 that says so.
 */
export const makeFakeAnthropic = (script: readonly FakeReply[]) => {
  const queue = [...script];
  const requests: { readonly body: Record<string, unknown>; readonly headers: Headers; readonly signal: AbortSignal | undefined }[] = [];
  const waiters: { n: number; resolve: () => void }[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const signal = init?.signal ?? undefined;
    requests.push({ body, headers: new Headers(init?.headers), signal });
    for (const w of waiters.filter((w) => w.n <= requests.length)) w.resolve();
    const reply = queue.shift();
    if (!reply || "error" in reply) {
      const error = reply?.error ?? {
        status: 500,
        type: "api_error",
        message: `The fake Anthropic API has no reply scripted for request ${requests.length}.`,
      };
      return new Response(JSON.stringify({ type: "error", error: { type: error.type, message: error.message } }), {
        status: error.status,
        headers: { "content-type": "application/json", ...(reply && "headers" in reply ? reply.headers : {}) },
      });
    }
    const frames = events(reply, String(body.model));
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const e of frames.slice(0, reply.hang ? -2 : undefined)) controller.enqueue(frame(e));
        if (!reply.hang) return controller.close();
        if (!signal?.aborted) await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
        controller.error(new DOMException("The request was aborted.", "AbortError"));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const arrived = (n: number) => (requests.length >= n ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ n, resolve })));
  return { fetch: fetch as unknown as typeof globalThis.fetch, requests, arrived };
};
