import { expect, test } from "bun:test";
import { Effort } from "@verdandi/contracts";
import { builtInCatalog } from "./catalog.ts";
import { loadPolicy } from "./policy.ts";
import { route } from "./route.ts";
import { rules } from "./rules.ts";

const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** A cheap metered model the policy prefers, and a local one that is always there. */
const catalog = [
  ...builtInCatalog,
  {
    harness: "fake",
    provider: "fake-api",
    model: "fake-api",
    access: "metered",
    tier: "S",
    context: 200_000,
    vision: false,
    efforts: Effort.literals,
    price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.12 },
  },
  {
    harness: "fake",
    provider: "fake",
    model: "fake",
    access: "local",
    tier: "M",
    context: 1_000_000,
    vision: true,
    efforts: Effort.literals,
    price: free,
  },
] as const;
const policy = loadPolicy(
  [
    {
      source: "test",
      data: {
        targets: {
          api: { harness: "fake", provider: "fake-api", model: "fake-api" },
          local: { harness: "fake", provider: "fake", model: "fake" },
        },
        routes: { "ask.explain": { prefer: ["api"], effort: "low" } },
      },
    },
  ],
  catalog,
);
const TEXT = "What does this reducer do?";
const capped = { cap: "profile's daily cap", paying: [] };

test("a reached spend cap moves a task off a metered target, and the reason names the cap", () => {
  const plain = route({ text: TEXT, mode: "build", harnesses: ["fake"] }, policy, rules);
  expect([plain.target.model, plain.target.access]).toEqual(["fake-api", "metered"]);

  const decision = route({ text: TEXT, mode: "build", harnesses: ["fake"], capped }, policy, rules);
  expect([decision.target.model, decision.target.access, decision.effort]).toEqual(["fake", "local", "low"]);
  expect(decision.reason).toBe(
    `Looks like ask.explain ("what does"), but the profile's daily cap of metered spend is reached, so it runs on fake at low effort instead of the metered fake-api.`,
  );
  expect(decision.trace.find((t) => t.stage === "candidates")?.note).toContain("api: the profile's daily cap of metered spend is reached");
});

test("a subscription running on extra usage counts as metered while a cap is reached", () => {
  const built = loadPolicy(
    [{ source: "test", data: { targets: { local: { harness: "fake", provider: "fake", model: "fake" } } } }],
    catalog,
  );
  const text = "Where is the auth middleware?";
  const input = { text, mode: "build", harnesses: ["claude-code", "fake"] } as const;
  expect(route(input, built, rules).target.model).toBe("haiku");

  const decision = route({ ...input, capped: { cap: "project's monthly cap", paying: ["claude-code"] } }, built, rules);
  expect(decision.target.harness).not.toBe("claude-code");
  expect(decision.reason).toContain(
    "but the project's monthly cap of metered spend is reached, so it runs on fake at low effort instead of haiku on extra usage.",
  );
});

test("a pin ignores the cap: the user's pick stands, and the turn is the decider's to refuse", () => {
  const pin = { target: { harness: "fake", provider: "fake-api", model: "fake-api", access: "metered" }, effort: "low" } as const;
  const decision = route({ text: TEXT, mode: "build", harnesses: ["fake"], pin, capped }, policy, rules);
  expect([decision.source, decision.target.model]).toEqual(["pin", "fake-api"]);
});
