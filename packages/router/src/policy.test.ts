import { expect, test } from "bun:test";
import { builtInCatalog, loadPolicy, PolicyError } from "./policy.ts";

const project = (yaml: string) => ({ source: ".verdandi/routing.yaml", data: Bun.YAML.parse(yaml) });

test("a project layer changes only what it names", () => {
  const p = loadPolicy([project("mode: thrifty\nroutes:\n  review: { effort: high }\n")]);
  expect(p.mode).toBe("thrifty");
  expect(p.routes.review).toMatchObject({ prefer: ["cc-opus"], effort: "high", thrifty: { effort: "low" } });
  expect(p.routes["chore.git"]?.prefer).toEqual(["cc-haiku"]);
});

test("restrictions add up across layers", () => {
  const p = loadPolicy([
    { source: "profile", data: { restrictions: [{ match: "secrets/**", forbid: ["local"] }] } },
    project("restrictions:\n  - { match: 'packages/billing/**', minTier: L }\n"),
  ]);
  expect(p.restrictions.map((r) => r.match)).toEqual(["secrets/**", "packages/billing/**"]);
});

test("a project names its verifiers under escalation", () => {
  expect(loadPolicy().verifiers).toEqual([]);
  expect(loadPolicy([project("escalation:\n  verifiers: [bun test, bun run typecheck]\n")]).verifiers).toEqual([
    "bun test",
    "bun run typecheck",
  ]);
});

test("the same tool error escalates after 3 repeats unless a project sets escalation.repeatedErrors, 0 for never", () => {
  expect(loadPolicy().escalation.repeatedErrors).toBe(3);
  expect(loadPolicy([project("escalation: { repeatedErrors: 0 }\n")]).escalation.repeatedErrors).toBe(0);
});

test.each([
  ["escalation: { repeatedErrors: -1 }\n", /\.verdandi\/routing\.yaml: [\s\S]*\["escalation"\]\["repeatedErrors"\]/],
  ["escalation:\n  verifier: [bun test]\n", /\.verdandi\/routing\.yaml: [\s\S]*\["escalation"\]\["verifier"\]/],
  ["routes:\n  review: { effort: extreme }\n", /\.verdandi\/routing\.yaml: [\s\S]*\["routes"\]\["review"\]\["effort"\]/],
  ["routes:\n  code.magic: { effort: low }\n", /\.verdandi\/routing\.yaml: [\s\S]*\["routes"\]\["code\.magic"\]/],
  ["modes: thrifty\n", /\.verdandi\/routing\.yaml: [\s\S]*\["modes"\]/],
  ["fallback: { maxCost: 0 }\n", /\.verdandi\/routing\.yaml: [\s\S]*\["fallback"\]\["maxCost"\]/],
  [
    "routes:\n  review: { prefer: [cc-gpt] }\n",
    '.verdandi/routing.yaml: routes.review.prefer: unknown target "cc-gpt"; define it under targets.',
  ],
  [
    "routes:\n  review: { subagents: { explorer: { prefer: [cc-mini] } } }\n",
    '.verdandi/routing.yaml: routes.review.subagents.explorer.prefer: unknown target "cc-mini"; define it under targets.',
  ],
  [
    "routes:\n  review: { subagents: { tester: { prefer: [cc-haiku] } } }\n",
    /\.verdandi\/routing\.yaml: [\s\S]*\["subagents"\]\["tester"\]/,
  ],
  [
    "targets:\n  cc-mini: { harness: claude-code, provider: claude-subscription, model: mini }\n",
    ".verdandi/routing.yaml: targets.cc-mini: model mini from claude-subscription on claude-code isn't in the model catalog.",
  ],
])("bad policy fails loudly, naming the file and the key: %s", (yaml, message) => {
  expect(() => loadPolicy([project(yaml)])).toThrow(PolicyError);
  expect(() => loadPolicy([project(yaml)])).toThrow(message);
});

test("a policy that asks for an effort its model doesn't take fails loudly, naming the file and the key", () => {
  const old = {
    harness: "claude-code",
    provider: "claude-subscription",
    model: "opus-4-6",
    access: "subscription",
    tier: "L",
    context: 1_000_000,
    vision: true,
    efforts: ["low", "medium", "high", "max"],
    price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  } as const;
  const yaml =
    "targets:\n  cc-old: { harness: claude-code, provider: claude-subscription, model: opus-4-6 }\n" +
    "routes:\n  review: { prefer: [cc-old], max: { effort: xhigh } }\n";
  const load = () => loadPolicy([project(yaml)], [...builtInCatalog, old]);
  expect(load).toThrow(PolicyError);
  expect(load).toThrow(
    ".verdandi/routing.yaml: routes.review.max.effort: xhigh isn't an effort level of opus-4-6 (cc-old, from routes.review.prefer), " +
      "which takes low, medium, high, max. Pick one of those, or another target.",
  );
});
