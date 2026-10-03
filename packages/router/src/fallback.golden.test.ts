import { expect, test } from "bun:test";
import type { CatalogEntry, ProviderHealth, RouteTarget } from "@verdandi/contracts";
import { builtInCatalog } from "./catalog.ts";
import { fallback } from "./fallback.ts";
import { loadPolicy } from "./policy.ts";

const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
const price = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
const model = (provider: string, name: string, tier: CatalogEntry["tier"]): CatalogEntry => ({
  harness: "native",
  provider,
  model: name,
  access: "metered",
  tier,
  context: 1_000_000,
  vision: true,
  efforts: name === "haiku" ? [] : efforts,
  price,
});
const catalog = [
  ...builtInCatalog,
  model("anthropic", "sonnet", "M"),
  model("anthropic", "opus", "L"),
  model("anthropic", "haiku", "S"),
  model("other", "other-large", "L"),
];
const policy = loadPolicy(
  [
    {
      source: "test",
      data: {
        targets: {
          sonnet: { harness: "native", provider: "anthropic", model: "sonnet" },
          opus: { harness: "native", provider: "anthropic", model: "opus" },
          haiku: { harness: "native", provider: "anthropic", model: "haiku" },
          other: { harness: "native", provider: "other", model: "other-large" },
        },
        routes: { "code.edit.local": { prefer: ["sonnet", "opus", "other"], effort: "medium" } },
        fallback: { prefer: ["haiku"] },
      },
    },
  ],
  catalog,
);
const sonnet: RouteTarget = { harness: "native", provider: "anthropic", model: "sonnet", access: "metered" };
const until = "2026-10-03T14:05:00.000Z";
/** A failure of sonnet, or with `model: null` of its whole provider. */
const failed = ({
  model = "sonnet",
  ...f
}: Partial<Omit<ProviderHealth, "model">> & { readonly model?: string | null }): ProviderHealth => ({
  provider: "anthropic",
  ...(model === null ? {} : { model }),
  reason: "overloaded",
  until,
  reset: false,
  error: "Overloaded",
  ...f,
});
const base = { target: sonnet, effort: "high", taskClass: "code.edit.local" } as const;

test("an overloaded model falls back to the next healthy target its task's class accepts, at the turn's effort", () => {
  const f = fallback({ ...base, failure: failed({}) }, policy);
  expect(f).toEqual({
    target: { harness: "native", provider: "anthropic", model: "opus", access: "metered" },
    effort: "high",
    reason:
      "anthropic is overloaded on sonnet until 14:05 UTC, so this turn falls back to opus at high effort, from code.edit.local's route.",
  });
});

test("with every target its class accepts down, it falls back to the default route's", () => {
  const health = [failed({ model: "opus" }), failed({ provider: "other", model: "other-large", reason: "server_error" })];
  const f = fallback({ ...base, failure: failed({ reason: "rate_limit", reset: true }), health }, policy);
  expect(f).toMatchObject({ target: { model: "haiku" }, effort: "high" });
  expect(f.reason).toBe("anthropic is rate-limiting sonnet until 14:05 UTC, so this turn falls back to haiku, from the default route.");
});

test("a rejected key falls back only to another provider", () => {
  const f = fallback({ ...base, failure: failed({ model: null, reason: "auth", error: "invalid x-api-key" }) }, policy);
  expect(f).toMatchObject({ target: { provider: "other", model: "other-large" } });
  expect(f.reason).toBe(
    "anthropic rejected the API key until 14:05 UTC, so this turn falls back to other-large at high effort, from code.edit.local's route.",
  );
});

test("a route the user picked never falls back, and says how to go on", () => {
  expect(fallback({ ...base, failure: failed({}), pinned: "thread" }, policy)).toEqual({
    reason:
      "anthropic is overloaded on sonnet until 14:05 UTC, and you picked this route, so Verdandi doesn't move it: pick another route to go on.",
  });
  expect(fallback({ ...base, failure: failed({}), pinned: "at" }, policy).reason).toBe(
    "anthropic is overloaded on sonnet until 14:05 UTC, and you pinned this task to it with @sonnet, so Verdandi doesn't move it: pick another route to go on.",
  );
});

test("billing needs the user, so it never falls back", () => {
  expect(fallback({ ...base, failure: failed({ model: null, reason: "billing" }) }, policy)).toEqual({
    reason:
      "anthropic refused the request for billing until 14:05 UTC, which needs you: settle it with anthropic, or pick another route. Verdandi doesn't move the turn's spend to another account.",
  });
});

test("a reached spend cap refuses a metered fallback, naming the cap", () => {
  const capped = { cap: "profile's daily cap", paying: [] };
  expect(fallback({ ...base, failure: failed({}), capped }, policy)).toEqual({
    reason:
      "anthropic is overloaded on sonnet until 14:05 UTC, and the profile's daily cap of metered spend is reached, so Verdandi doesn't fall back to the metered opus: raise the cap, or pick another route.",
  });
});

test("a turn falls back at most once", () => {
  expect(fallback({ ...base, target: { ...sonnet, model: "opus" }, failure: failed({ model: "opus" }), fellBack: true }, policy)).toEqual({
    reason:
      "anthropic is overloaded on opus until 14:05 UTC, and this turn fell back once already, so it stops here: try again shortly, or pick another route.",
  });
});

test("with nothing healthy left on the harness it stops, naming the routes it tried", () => {
  const health = [failed({ model: null, reason: "server_error" }), failed({ provider: "other", model: null, reason: "timeout" })];
  expect(fallback({ ...base, failure: failed({}), health }, policy).reason).toBe(
    "anthropic is overloaded on sonnet until 14:05 UTC, and no other healthy target on native is on code.edit.local's route or the default route: try again later, or pick another route.",
  );
});
