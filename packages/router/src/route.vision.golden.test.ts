import { expect, test } from "bun:test";
import { Effort } from "@verdandi/contracts";
import { builtInCatalog, loadPolicy } from "./policy.ts";
import { route } from "./route.ts";
import { rules } from "./rules.ts";

const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** One fake model that reads images and a cheaper one that doesn't. */
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
          small: { harness: "fake", provider: "fake", model: "fake-small" },
          seeing: { harness: "fake", provider: "fake", model: "fake" },
        },
        routes: { "ask.explain": { prefer: ["small"], effort: "low" } },
      },
    },
  ],
  catalog,
);
const TEXT = "What does this error dialog mean?";

test("an image task avoids a target that can't read images, and says why", () => {
  const plain = route({ text: TEXT, mode: "build", harnesses: ["fake"] }, policy, rules);
  expect(plain.target.model).toBe("fake-small");

  const withImage = route({ text: TEXT, mode: "build", harnesses: ["fake"], images: 1 }, policy, rules);
  expect(withImage.target.model).toBe("fake");
  expect(withImage.trace.find((t) => t.stage === "candidates")?.note).toContain("small: it can't read the attached image");
  expect(withImage.trace.find((t) => t.stage === "signals")?.note).toContain("1 image attached");
  expect(withImage.reason).toContain("unavailable");
});

test("an image task with no target that reads images has no route", () => {
  const blind = loadPolicy(
    [
      {
        source: "test",
        data: {
          targets: { small: { harness: "fake", provider: "fake", model: "fake-small" } },
          routes: { "ask.explain": { prefer: ["small"] } },
        },
      },
    ],
    catalog,
  );
  expect(() => route({ text: TEXT, mode: "build", harnesses: ["fake"], images: 2 }, blind, rules)).toThrow(
    "can't read the attached images",
  );
});
