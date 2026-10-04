import type { CatalogEntry, HarnessError, ProviderFailure, Route } from "@verdandi/contracts";
import type { Sent } from "./cache-check.ts";
import type { Failure } from "./provider-failure.ts";
import type { ToolSearch } from "./tool-search.ts";
import type { Block, Compression, Entry, Prefix } from "./transcript.ts";

/** One model request of a native turn, as the loop hands it to the provider that serves its model. */
export type ProviderRequest = {
  readonly route: Route;
  readonly entry: CatalogEntry;
  readonly prefix: Prefix;
  readonly entries: readonly Entry[];
  /** The session's compressions (DESIGN §16): the request is built from the latest, and the cache check counts them. */
  readonly compressions: readonly Compression[];
  readonly maxTokens: number;
  readonly signal: AbortSignal;
  /** Called with the request's fingerprint just before it's sent, so the adapter can name a cache break (ADR 0022). */
  readonly check: (sent: Sent) => void;
};

/** A whole reply: its blocks, committed to the transcript unchanged, why it stopped, and its tokens. */
export type ProviderReply = {
  readonly content: Block[];
  /** `pause_turn`: the API paused a long run of its own tools (tool search), and sending the conversation again goes on. */
  readonly stop: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn";
  /** Why the model refused, when the provider says. */
  readonly refusal?: string;
  readonly tokens: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
  };
};

/**
 * One API format behind the native loop (DESIGN §9.5, ADR 0035): it turns the session's normalized blocks into its
 * request, streams the reply's text as it comes, and returns the reply as blocks. `id` is the catalog's `provider`.
 */
export type Provider = {
  readonly id: string;
  /** What the provider runs on, for `session.started`'s `harnessVersion`. */
  readonly version: string;
  /** How a session that opens on this provider finds the MCP tools it defers (DESIGN §9.4). */
  readonly toolSearch: ToolSearch;
  readonly send: (request: ProviderRequest) => AsyncGenerator<string, ProviderReply>;
  /**
   * What an error `send` raised for `model` says about the provider's health (`provider.failed`, DESIGN §9.5), or
   * undefined for one that isn't the provider's: an interrupt, a refused request, the network.
   */
  readonly classify: (error: unknown, model: string) => Failure | undefined;
  /** The fix a turn that ends on a failure of `reason` names besides trying another route, e.g. how to replace a rejected key. */
  readonly fix: (reason: ProviderFailure) => string | undefined;
  /** The turn's failure as the user reads it, the cause and the fix, for an error this provider raised; never holds a key. */
  readonly failure: (error: unknown) => HarnessError | undefined;
};
