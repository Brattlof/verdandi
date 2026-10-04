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

/** A request's fingerprint: what keys its cache, hashed, the route it ran on, and how many compressions it was built after. */
export type Sent = {
  readonly route: Route;
  readonly compressions: number;
  readonly system: string;
  readonly tools: string;
  readonly params: ReturnType<typeof keyParams>;
  /**
   * One hash per content block of the messages, in order, with where it sits (1-based), and one per effort message's
   * effort (block 0, `effort`), which a model without effort levels is sent without.
   */
  readonly blocks: readonly { readonly hash: string; readonly message: number; readonly block: number; readonly effort?: true }[];
};

export const hash = (value: unknown) => Bun.hash(JSON.stringify(value)).toString(36);

export const fingerprint = (route: Route, body: Anthropic.MessageCreateParams, compressions = 0): Sent => ({
  route,
  compressions,
  system: hash(body.system),
  tools: hash(body.tools),
  params: keyParams(body),
  blocks: body.messages.flatMap((m, i) => {
    const effort = (m as { readonly output_config?: unknown }).output_config;
    return [
      ...(effort ? [{ hash: hash([m.role, effort]), message: i + 1, block: 0, effort: true as const }] : []),
      ...(typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content).map((b, j) => ({
        hash: hash([m.role, b]),
        message: i + 1,
        block: j + 1,
      })),
    ];
  }),
});

const sameRoute = (a: Route, b: Route) => a.model === b.model && a.effort === b.effort;

/** Blocks as `to`'s model is sent them: a switch to or from a model without effort levels adds or drops effort messages. */
const comparable = (s: Sent, to: Sent) => (s.params.model === to.params.model ? s.blocks : s.blocks.filter((b) => !b.effort));

/**
 * What changed between two requests of one session that drops the cache, or undefined when `next` extends `previous`:
 * the same system prompt and tools, `previous`'s message blocks as a prefix of `next`'s (so a user message joined
 * after an interrupt still extends it), and the same model, thinking and effort unless the route changed, which the
 * task records (escalation, de-escalation, plan approval, a fallback or a route pick). A turn's own effort is an effort
 * message, which extends the messages like any other (#185). A compression written since `previous` (DESIGN §16) is the
 * one other allowed break, of the messages only; a new session has no previous request.
 */
export const cacheBreak = (previous: Sent, next: Sent): string | undefined => {
  if (previous.system !== next.system) return "the system prompt changed";
  if (previous.tools !== next.tools) return "the tools changed";
  // A route change may move the parameters; the messages must still extend.
  if (sameRoute(previous.route, next.route)) {
    const changed = (Object.keys(previous.params) as (keyof Sent["params"])[]).filter((k) => previous.params[k] !== next.params[k]);
    if (changed.length > 0) return `${changed.join(" and ")} changed without a route change`;
  }
  if (next.compressions !== previous.compressions) return undefined;
  const before = comparable(previous, next);
  const after = comparable(next, previous);
  const at = before.findIndex((b, i) => after[i]?.hash !== b.hash);
  const b = before[at];
  return b && `message ${b.message} ${after[at] ? "changed" : "is gone"} (${b.effort ? "its effort" : `block ${b.block}`})`;
};
