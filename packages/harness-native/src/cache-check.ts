import type Anthropic from "@anthropic-ai/sdk";
import type { Route } from "@verdandi/contracts";

/** What `cacheBreaks` does with a request that breaks the prompt cache: tests throw, verdandid logs a warning. */
export type CacheBreaks = "throw" | "warn";

/** The parameters besides the bytes that key the cache: changing one drops the cached messages. */
const keyParams = (body: Anthropic.MessageCreateParams) => ({
  model: body.model,
  thinking: JSON.stringify(body.thinking ?? null),
  effort: JSON.stringify(body.output_config?.effort ?? null),
});

/** A request's fingerprint: what keys its cache, hashed, and the route it ran on. */
export type Sent = {
  readonly route: Route;
  readonly system: string;
  readonly tools: string;
  readonly params: ReturnType<typeof keyParams>;
  /** One hash per content block of the messages, in order, with where it sits (1-based). */
  readonly blocks: readonly { readonly hash: string; readonly message: number; readonly block: number }[];
};

const hash = (value: unknown) => Bun.hash(JSON.stringify(value)).toString(36);

export const fingerprint = (route: Route, body: Anthropic.MessageCreateParams): Sent => ({
  route,
  system: hash(body.system),
  tools: hash(body.tools),
  params: keyParams(body),
  blocks: body.messages.flatMap((m, i) =>
    (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content).map((b, j) => ({
      hash: hash([m.role, b]),
      message: i + 1,
      block: j + 1,
    })),
  ),
});

const sameRoute = (a: Route, b: Route) => a.model === b.model && a.effort === b.effort;

/**
 * What changed between two requests of one session that drops the cache, or undefined when `next` extends `previous`:
 * the same system prompt and tools, `previous`'s message blocks as a prefix of `next`'s (so a user message joined
 * after an interrupt still extends it), and the same model, thinking and effort unless the route changed, which the
 * task records (escalation, de-escalation, plan approval or a route pick). Today an effort change between turns is a
 * route change; once effort moves into the messages (#185) it stops being a break. Compression (#186) will be the
 * other allowed break; a new session has no previous request.
 */
export const cacheBreak = (previous: Sent, next: Sent): string | undefined => {
  if (previous.system !== next.system) return "the system prompt changed";
  if (previous.tools !== next.tools) return "the tools changed";
  // A route change may move the parameters; the messages must still extend.
  if (sameRoute(previous.route, next.route)) {
    const changed = (Object.keys(previous.params) as (keyof Sent["params"])[]).filter((k) => previous.params[k] !== next.params[k]);
    if (changed.length > 0) return `${changed.join(" and ")} changed without a route change`;
  }
  const at = previous.blocks.findIndex((b, i) => next.blocks[i]?.hash !== b.hash);
  const b = previous.blocks[at];
  return b && `message ${b.message} ${next.blocks[at] ? "changed" : "is gone"} (block ${b.block})`;
};
