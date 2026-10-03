import { expect, test } from "bun:test";
import type { CatalogEntry, ProviderHealth } from "@verdandi/contracts";
import { builtInCatalog } from "./catalog.ts";
import { loadPolicy } from "./policy.ts";
import { route } from "./route.ts";
import { rules } from "./rules.ts";

const efforts = ["low", "medium", "high", "xhigh", "max"] as const;
const model = (name: string, tier: CatalogEntry["tier"], input: number): CatalogEntry => ({
  harness: "native",
  provider: "anthropic",
  model: name,
  access: "metered",
  tier,
  context: 1_000_000,
  vision: true,
  efforts,
  price: { input, output: input * 5, cacheRead: input / 10, cacheWrite: input * 1.25 },
});
const policy = loadPolicy(
  [
    {
      source: "test",
      data: {
        targets: {
          sonnet: { harness: "native", provider: "anthropic", model: "sonnet" },
          opus: { harness: "native", provider: "anthropic", model: "opus" },
        },
        routes: { "code.edit.local": { prefer: ["sonnet"], effort: "medium" } },
      },
    },
  ],
  [...builtInCatalog, model("sonnet", "M", 2), model("opus", "L", 4)],
);
const TEXT = "Fix the typo in src/a.ts";
const overloaded: ProviderHealth = {
  provider: "anthropic",
  model: "sonnet",
  reason: "overloaded",
  until: "2026-10-03T14:05:00.000Z",
  reset: false,
  error: "Overloaded",
};

test("a model whose provider failed is out of new tasks, and the reason names the provider, the failure and until when", () => {
  const d = route({ text: TEXT, mode: "build", harnesses: ["native"], health: [overloaded] }, policy, rules);
  expect([d.target.model, d.effort]).toEqual(["opus", "medium"]);
  expect(d.reason).toBe(
    'Looks like code.edit.local ("fix", "typo"), but anthropic is overloaded on sonnet until 14:05 UTC, so it runs on opus at medium effort instead.',
  );
  expect(d.trace.find((t) => t.stage === "candidates")?.note).toContain("sonnet: anthropic is overloaded on sonnet until 14:05 UTC");
});

test("a failure of the whole provider takes all its models out", () => {
  const auth: ProviderHealth = { ...overloaded, reason: "auth", error: "invalid x-api-key" };
  const { model: _, ...wide } = auth;
  const d = route({ text: TEXT, mode: "build", harnesses: ["native", "claude-code"], health: [wide] }, policy, rules);
  expect(d.target.harness).toBe("claude-code");
  expect(d.reason).toContain("but anthropic rejected the API key until 14:05 UTC, so it runs on");
});

test("another model's failure leaves the route as it was", () => {
  const d = route({ text: TEXT, mode: "build", harnesses: ["native"], health: [{ ...overloaded, model: "opus" }] }, policy, rules);
  expect(d.target.model).toBe("sonnet");
  expect(d.reason).toBe('Looks like code.edit.local ("fix", "typo"), so it runs on sonnet at medium effort.');
});

test("a pin ignores provider health: the user's pick stands", () => {
  const pin = { target: { harness: "native", provider: "anthropic", model: "sonnet", access: "metered" }, effort: "low" } as const;
  const d = route({ text: TEXT, mode: "build", pin, health: [overloaded] }, policy, rules);
  expect([d.source, d.target.model, d.reason]).toEqual(["pin", "sonnet", "You pinned sonnet at low effort."]);
});
