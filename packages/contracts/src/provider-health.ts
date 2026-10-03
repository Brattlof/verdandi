import { Schema } from "effect";

/**
 * Why a provider's request failed once its SDK stopped retrying (DESIGN §9.5): a closed set every provider maps its errors
 * into. `context_overflow` is the request's own fault, so it says nothing about the provider's health.
 */
export const ProviderFailure = Schema.Literals([
  "rate_limit",
  "overloaded",
  "server_error",
  "timeout",
  "model_not_found",
  "auth",
  "billing",
  "context_overflow",
]);
export type ProviderFailure = typeof ProviderFailure.Type;

/**
 * How long a provider stays out of new routes after a failure that didn't say when to try again. A later success ends it
 * sooner. ponytail: fixed per reason; back off on repeated failures (30 s up to a day) if one provider keeps failing.
 */
export const failureCooldownMs: Record<ProviderFailure, number> = {
  rate_limit: 60_000,
  overloaded: 30_000,
  server_error: 30_000,
  timeout: 30_000,
  model_not_found: 3_600_000,
  auth: 3_600_000,
  billing: 3_600_000,
  context_overflow: 0,
};

/**
 * After a provider reports a reset still this far ahead, a thread's next turn starts on a fallback instead of its route;
 * a sooner reset is waited out, since every switch writes a cold cache.
 */
export const minSwitchResetMs = 60_000;

/**
 * A provider, or one of its models, out of new routes until `until` (ISO), for `reason` (DESIGN §9.5): `model` when its
 * limits are per model (Anthropic's 429 and 529), absent when the whole provider failed (a rejected key). `reset`: the
 * provider named `until`; otherwise it's Verdandi's cooldown. `error` is the provider's own message.
 */
export const ProviderHealth = Schema.Struct({
  provider: Schema.String,
  model: Schema.optionalKey(Schema.String),
  reason: ProviderFailure,
  until: Schema.String,
  reset: Schema.Boolean,
  error: Schema.String,
});
export type ProviderHealth = typeof ProviderHealth.Type;

const failures: Record<ProviderFailure, (provider: string, model: string | undefined) => string> = {
  rate_limit: (p, m) => `${p} is rate-limiting ${m ?? "this key"}`,
  overloaded: (p, m) => `${p} is overloaded${m ? ` on ${m}` : ""}`,
  server_error: (p) => `${p} is failing with server errors`,
  timeout: (p) => `${p} isn't answering in time`,
  model_not_found: (p, m) => `${p} doesn't serve ${m ?? "this model"}`,
  auth: (p) => `${p} rejected the API key`,
  billing: (p) => `${p} refused the request for billing`,
  context_overflow: (p, m) => `the conversation is too large for ${m ?? p}`,
};

/** A failure as a sentence fragment, e.g. `anthropic is overloaded on claude-sonnet-5-5 until 14:05 UTC`. */
export const describeFailure = (f: Pick<ProviderHealth, "provider" | "model" | "reason"> & { readonly until?: string }) =>
  `${failures[f.reason](f.provider, f.model)}${f.until ? ` until ${new Date(f.until).toISOString().slice(11, 16)} UTC` : ""}`;

/** Whether `health` takes `provider`'s `model` out of routes: it's that model's, or the whole provider's. */
export const healthCovers = (health: Pick<ProviderHealth, "provider" | "model">, provider: string, model: string) =>
  health.provider === provider && (health.model === undefined || health.model === model);
