import Anthropic from "@anthropic-ai/sdk";
import { failureCooldownMs, type ProviderFailure } from "@verdandi/contracts";

/** A request's failure as the router reads it (DESIGN §9.5): what `provider.failed` reports, besides the provider. */
export type Failure = {
  readonly reason: ProviderFailure;
  readonly model?: string;
  readonly until: string;
  readonly reset: boolean;
  readonly error: string;
};

/** The HTTP statuses every provider's failures share; any other 5xx is a server error. */
const byStatus: Readonly<Record<number, ProviderFailure>> = {
  401: "auth",
  402: "billing",
  404: "model_not_found",
  408: "timeout",
  413: "context_overflow",
  429: "rate_limit",
  504: "timeout",
  529: "overloaded",
};
/** An error event in the middle of a stream has no status, only its type. */
const byType: Readonly<Record<string, ProviderFailure>> = {
  overloaded_error: "overloaded",
  rate_limit_error: "rate_limit",
  api_error: "server_error",
  timeout_error: "timeout",
  authentication_error: "auth",
  billing_error: "billing",
  not_found_error: "model_not_found",
  request_too_large: "context_overflow",
};
/**
 * Limits that are per model (Anthropic's, and an endpoint's rate limits and missing models) name the model and leave the
 * provider's others in routes.
 */
const perModel: ReadonlySet<ProviderFailure> = new Set(["rate_limit", "overloaded", "model_not_found", "context_overflow"]);

/** When the API said to try again: `retry-after`, else the latest of its rate limits' resets (RFC 3339). */
const resetOf = (headers: Headers | undefined, now: number) => {
  const after = headers?.get("retry-after");
  const seconds = Number(after);
  const at = after ? (Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(after)) : Number.NaN;
  if (at > now) return at;
  const resets = ["requests", "tokens", "input-tokens", "output-tokens"]
    .map((limit) => Date.parse(headers?.get(`anthropic-ratelimit-${limit}-reset`) ?? ""))
    .filter((t) => t > now);
  return resets.length > 0 ? Math.max(...resets) : undefined;
};

/**
 * What a failed request of `model` to the Anthropic API says about the provider, once the SDK stopped retrying it, or
 * undefined for a failure that isn't the provider's: an interrupt, a refused request, the network.
 */
export const classify = (error: unknown, model: string, now = Date.now()): Failure | undefined => {
  if (!(error instanceof Anthropic.APIError) || error instanceof Anthropic.APIUserAbortError) return undefined;
  const status = error.status;
  const found: ProviderFailure | undefined =
    error instanceof Anthropic.APIConnectionTimeoutError
      ? "timeout"
      : error instanceof Anthropic.APIConnectionError
        ? undefined
        : (statusFailure(status, error.message) ?? (error.type ? byType[error.type] : undefined));
  if (!found) return undefined;
  // The API's own words: its error body's message, which the SDK's `message` wraps in the whole body.
  const said = (error.error as { readonly error?: { readonly message?: unknown } } | undefined)?.error?.message;
  const detail = typeof said === "string" ? said : error.message;
  return failureOf(found, model, resetOf(error.headers, now), status ? `${status} ${detail}` : detail, now);
};

/** What an HTTP status says about the provider, any provider's: a 400 only when the conversation outgrew the context. */
export const statusFailure = (status: number | undefined, message: string): ProviderFailure | undefined =>
  status === undefined
    ? undefined
    : status === 400 && /prompt is too long|context (window|length)/i.test(message)
      ? "context_overflow"
      : (byStatus[status] ?? (status >= 500 ? "server_error" : undefined));

/**
 * A failure of `found`, with when to try again: `reset` (epoch ms) when the provider named it for a rate limit or
 * billing, else Verdandi's cooldown. A used-up usage window can come as a 402: with a reset it's a rate limit, never
 * billing.
 */
export const failureOf = (found: ProviderFailure, model: string, reset: number | undefined, error: string, now: number): Failure => {
  const at = found === "rate_limit" || found === "billing" ? reset : undefined;
  const reason = found === "billing" && at !== undefined ? "rate_limit" : found;
  return {
    reason,
    ...(perModel.has(reason) && { model }),
    until: new Date(at ?? now + failureCooldownMs[reason]).toISOString(),
    reset: at !== undefined,
    error,
  };
};
