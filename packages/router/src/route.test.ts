import { describe, expect, test } from "bun:test";
import { Effort, type RouteTarget } from "@verdandi/contracts";
import { builtInCatalog } from "./catalog.ts";
import { loadPolicy } from "./policy.ts";
import { PinError, RouterError, route } from "./route.ts";
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
    expect(d.reason).toBe("You pinned haiku.");
  });

  test("@name wins over the thread's pin, keeps the warm session's effort on its model, and ignores case", () => {
    const warm = { target: cc("opus"), effort: "xhigh", cachedTokens: 50_000 } as const;
    const d = route(
      { text: SEARCH, at: "Opus", mode: "build", pin: { target: cc("sonnet"), effort: "low" }, current: warm },
      policy,
      rules,
    );
    expect(d).toMatchObject({ source: "pin", target: cc("opus"), effort: "xhigh", reason: "Pinned with @opus." });
    expect(d.trace[0]?.note).toContain("the thread's effort");
  });

  test("an @name that isn't a model on a running harness throws, naming the ones that are", () => {
    expect(() => route({ text: SEARCH, at: "gpt", mode: "build", harnesses: ["claude-code"] }, policy, rules)).toThrow(
      new PinError("@gpt isn't a model Verdandi can run. Use one of @haiku, @sonnet, @opus, @fable."),
    );
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

  test("an approved Opus plan moves its build to Sonnet once the savings beat moving the plan's context", () => {
    const classify = () => ({ taskClass: "code.feature" as const, difficulty: 0.5, confidence: 0.9, why: "the task's class" });
    const current = { target: cc("opus"), effort: "high" as const, cachedTokens: 60_000 };
    const d = route({ text: "1. Add a toggle to src/settings.tsx", mode: "build", planApproved: true, current }, policy, classify);
    expect(`${d.target.model} ${d.effort}`).toBe("sonnet medium");
    expect(d.estimate?.switchCost).toBeGreaterThan(0);
    expect(d.trace.find((t) => t.stage === "policy")?.note).toStartWith("code.feature (build after its plan)");
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
      vision: true,
      efforts: Effort.literals,
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

describe("budget guards", () => {
  const guarded = loadPolicy([
    { source: "test", data: { routes: { "debug.investigate": { maxCost: 5, maxTurns: 40 } }, fallback: { maxCost: 1 } } },
  ]);

  test("a task takes its class's limits, and the fallback's where its class sets none", () => {
    expect(route({ text: DEBUG, mode: "build" }, guarded, rules).limits).toEqual({ maxCost: 5, maxTurns: 40 });
    expect(route({ text: SEARCH, mode: "build" }, guarded, rules).limits).toEqual({ maxCost: 1 });
  });

  test("a pinned task keeps its class's limits: the pin picks the route, not the budget", () => {
    const d = route({ text: DEBUG, mode: "build", pin: { target: cc("haiku"), effort: "low" } }, guarded, rules);
    expect(d.limits).toEqual({ maxCost: 5, maxTurns: 40 });
  });

  test("without limits in the policy a task has none", () => {
    expect(route({ text: DEBUG, mode: "build" }, policy, rules).limits).toBeUndefined();
  });
});

describe("subagents", () => {
  const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const catalog = [
    ...builtInCatalog,
    {
      harness: "fake",
      provider: "fake",
      model: "fake-small",
      access: "local",
      tier: "S",
      context: 200_000,
      vision: false,
      efforts: Effort.literals,
      price: free,
    } as const,
  ];
  const withSubagents = loadPolicy(
    [
      {
        source: "test",
        data: {
          targets: { "fake-small": { harness: "fake", provider: "fake", model: "fake-small" } },
          routes: {
            "code.feature": {
              subagents: { explorer: { prefer: ["cc-haiku"], effort: "low" }, reviewer: { prefer: ["fake-small"] } },
            },
          },
        },
      },
    ],
    catalog,
  );
  const FEATURE = "Implement dark mode for the settings page";

  test("a fresh session takes the policy's on the main route's harness; one with no target there keeps the harness default", () => {
    const d = route({ text: FEATURE, mode: "build" }, withSubagents, rules);
    expect(`${d.target.model} ${d.effort}`).toBe("sonnet medium");
    expect(d.subagents).toEqual({ explorer: { model: "haiku", effort: "low" } });
    expect(d.trace.find((t) => t.stage === "subagents")?.note).toBe(
      "explorer on haiku at low; reviewer: none of fake-small is available on claude-code, so it keeps the harness default",
    );
  });

  test("a profile without an effort takes the task's", () => {
    const p = loadPolicy([{ source: "test", data: { routes: { "code.feature": { subagents: { reviewer: { prefer: ["cc-opus"] } } } } } }]);
    expect(route({ text: FEATURE, mode: "build" }, p, rules).subagents).toEqual({ reviewer: { model: "opus", effort: "medium" } });
  });

  test("a warm session keeps the subagents it started with, whatever the policy says now, and so does a pin on it", () => {
    const started = { explorer: { model: "sonnet", effort: "high" } } as const;
    const current = { target: cc("sonnet"), effort: "medium" as const, cachedTokens: 10_000, subagents: started };
    const d = route({ text: FEATURE, mode: "build", current }, withSubagents, rules);
    expect(d.subagents).toEqual(started);
    expect(d.trace.find((t) => t.stage === "subagents")?.note).toBe(
      "kept the warm session's: explorer on sonnet at high; a session's subagents are fixed",
    );
    const pin = { target: cc("opus"), effort: "high" as const };
    expect(route({ text: FEATURE, mode: "build", current, pin }, withSubagents, rules).subagents).toEqual(started);
    expect(route({ text: FEATURE, mode: "build", pin }, withSubagents, rules).subagents).toBeUndefined();
  });
});
