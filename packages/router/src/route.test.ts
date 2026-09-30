import { describe, expect, test } from "bun:test";
import type { RouteTarget } from "@verdandi/contracts";
import { builtInCatalog, loadPolicy } from "./policy.ts";
import { RouterError, route } from "./route.ts";
import { rules } from "./rules.ts";

const cc = (model: string): RouteTarget => ({ harness: "claude-code", provider: "claude-subscription", model, access: "subscription" });
const policy = loadPolicy();
const SEARCH = "Where is the auth middleware?"; // ask.search → haiku low
const DEBUG = "Why does the upload keep failing? Investigate the root cause."; // debug.investigate → opus high

describe("pins", () => {
  test("a pin always wins, even over a restriction and a provider that's down", () => {
    const strict = loadPolicy([{ source: "test", data: { restrictions: [{ match: "**", minTier: "XL" }] } }]);
    const d = route(
      {
        text: `${SEARCH} src/auth.ts`,
        mode: "build",
        pin: { target: cc("haiku"), effort: "max" },
        providers: { "claude-subscription": { healthy: false } },
      },
      strict,
      rules,
    );
    expect(d).toMatchObject({ source: "pin", target: cc("haiku"), effort: "max", taskClass: "ask.search" });
    expect(d.reason).toBe("You pinned haiku at max effort.");
  });

  test("a pinned model the catalog doesn't know is kept, without a cost estimate", () => {
    const target = { ...cc("claude-opus-5-5[1m]") };
    const d = route({ text: SEARCH, mode: "build", pin: { target, effort: "high" } }, policy, rules);
    expect(d.target).toEqual(target);
    expect(d.estimate).toBeUndefined();
  });
});

describe("switch-cost gate", () => {
  test("keeps a warm session when the savings don't cover moving its context", () => {
    const d = route(
      { text: SEARCH, mode: "build", current: { target: cc("sonnet"), effort: "low", cachedTokens: 150_000 } },
      policy,
      rules,
    );
    expect(d.target.model).toBe("sonnet");
    expect(d.effort).toBe("low");
    expect(d.reason).toContain("stays on the warm sonnet");
    expect(d.estimate?.switchCost).toBe(0);
    expect(d.trace.find((t) => t.stage === "switch")?.note).toStartWith("stay:");
  });

  test("switches when the session is small enough that the savings win", () => {
    const d = route({ text: SEARCH, mode: "build", current: { target: cc("sonnet"), effort: "low", cachedTokens: 2_000 } }, policy, rules);
    expect(d.target.model).toBe("haiku");
    expect(d.estimate?.switchCost).toBeGreaterThan(0);
  });

  test("always switches to a more capable target, however much is cached", () => {
    const d = route({ text: DEBUG, mode: "build", current: { target: cc("haiku"), effort: "low", cachedTokens: 150_000 } }, policy, rules);
    expect(d.target.model).toBe("opus");
  });

  test("staying at a different effort reports the cache rewrite (ADR 0002)", () => {
    const d = route(
      { text: SEARCH, mode: "build", current: { target: cc("sonnet"), effort: "high", cachedTokens: 150_000 } },
      policy,
      rules,
    );
    expect(d.target.model).toBe("sonnet");
    expect(d.effort).toBe("low");
    expect(d.estimate?.switchCost).toBeGreaterThan(0);
  });
});

describe("candidates and fallbacks", () => {
  test("an unsure classification takes the budget mode's safe default", () => {
    const d = route({ text: "Refactor this function", mode: "build" }, policy, rules);
    expect(d.confidence).toBeLessThan(0.6);
    expect(`${d.target.model} ${d.effort}`).toBe("sonnet medium");
    expect(d.reason).toBe(
      "Not sure what kind of task this is (best guess code.edit.mechanical, confidence 0.33), so it runs on the balanced default, sonnet at medium effort.",
    );
  });

  test("a restriction on a path the task names drops targets below its tier", () => {
    const strict = loadPolicy([{ source: "test", data: { restrictions: [{ match: "packages/billing/**", minTier: "L" }] } }]);
    expect(route({ text: `${SEARCH} packages/billing/src/pay.ts`, mode: "build" }, strict, rules).target.model).toBe("opus");
    expect(route({ text: SEARCH, mode: "build" }, strict, rules).target.model).toBe("haiku");
  });

  test("a context too big for a model drops it, and the reason says what was used instead", () => {
    const d = route(
      { text: SEARCH, mode: "build", current: { target: cc("sonnet"), effort: "low", cachedTokens: 400_000 } },
      policy,
      rules,
    );
    expect(d.trace[0]?.note).toContain("cc-haiku: its 200K context can't hold 400K");
    expect(d.target.model).toBe("sonnet");
    expect(d.reason).toBe(
      "Looks like ask.search, but haiku is unavailable, so it runs on sonnet at low effort, the cheapest capable target left.",
    );
  });

  test("targets on a harness verdandid doesn't run are dropped", () => {
    const fake = {
      harness: "fake",
      provider: "fake",
      model: "fake",
      access: "local",
      tier: "M",
      context: 1_000_000,
      price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as const;
    const withFake = loadPolicy(
      [
        {
          source: "test",
          data: {
            targets: { "fake-m": { harness: "fake", provider: "fake", model: "fake" } },
            routes: { "ask.search": { prefer: ["cc-haiku", "fake-m"] } },
          },
        },
      ],
      [...builtInCatalog, fake],
    );
    const d = route({ text: SEARCH, mode: "build", harnesses: ["fake"] }, withFake, rules);
    expect(d.target).toEqual({ harness: "fake", provider: "fake", model: "fake", access: "local" });
    expect(d.trace[0]?.note).toContain("cc-haiku: the claude-code harness isn't running");
    expect(d.reason).toBe("Looks like ask.search, so it runs on fake at low effort.");
    expect(() => route({ text: SEARCH, mode: "build", harnesses: ["fake"] }, policy, rules)).toThrow(
      "cc-sonnet: the claude-code harness isn't running",
    );
  });

  test("with every provider down there is nothing to route to", () => {
    expect(() => route({ text: SEARCH, mode: "build", providers: { "claude-subscription": { remaining: 0 } } }, policy, rules)).toThrow(
      RouterError,
    );
  });

  test("low subscription quota raises its effective cost", () => {
    const plenty = route({ text: SEARCH, mode: "build" }, policy, rules).estimate?.cost ?? 0;
    const scarce =
      route({ text: SEARCH, mode: "build", providers: { "claude-subscription": { remaining: 0.1 } } }, policy, rules).estimate?.cost ?? 0;
    expect(scarce).toBeGreaterThan(plenty * 3);
  });
});
