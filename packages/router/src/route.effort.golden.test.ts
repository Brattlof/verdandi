import { expect, test } from "bun:test";
import { builtInCatalog } from "./catalog.ts";
import { loadPolicy } from "./policy.ts";
import { route } from "./route.ts";
import { rules } from "./rules.ts";

const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** A model that takes no xhigh or max, like Opus 4.6 without max. */
const old = {
  harness: "fake",
  provider: "fake",
  model: "fake-old",
  access: "local",
  tier: "XL",
  context: 1_000_000,
  vision: true,
  efforts: ["low", "medium", "high"],
  price: free,
} as const;
const policy = loadPolicy(
  [
    {
      source: "test",
      data: {
        targets: { old: { harness: "fake", provider: "fake", model: "fake-old" } },
        routes: { review: { prefer: ["cc-fable"], effort: "xhigh" } },
      },
    },
  ],
  [...builtInCatalog, old],
);
const REVIEW = "Review this diff for security issues";

test("a route the policy asks at an effort its model doesn't take runs at the nearest one it does, and the trace says so", () => {
  const d = route({ text: REVIEW, mode: "build", harnesses: ["fake"] }, policy, rules);
  expect(`${d.target.model} ${d.effort}`).toBe("fake-old high");
  expect(d.reason).toBe(
    "Looks like review, but fable is unavailable, so it runs on fake-old at high effort, the cheapest capable target left.",
  );
  expect(d.trace.findLast((t) => t.stage === "policy")?.note).toBe("fake-old takes low, medium, high, so xhigh is clamped to high");
});

test("a pin at an effort its model doesn't take is clamped too", () => {
  const target = { harness: "fake", provider: "fake", model: "fake-old", access: "local" } as const;
  const d = route({ text: REVIEW, mode: "build", pin: { target, effort: "max" } }, policy, rules);
  expect(d.effort).toBe("high");
  expect(d.reason).toBe("You pinned fake-old at max effort, which it doesn't take, so it runs at high.");
  expect(d.trace[1]).toEqual({ stage: "pin", note: "fake-old takes low, medium, high, so max is clamped to high" });
});

test("a model without effort levels names no effort in its reason", () => {
  const d = route({ text: "Where is the auth middleware?", mode: "build" }, loadPolicy(), rules);
  expect(d.reason).toBe("Looks like ask.search, so it runs on haiku.");
});
