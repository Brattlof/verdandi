import { expect, test } from "bun:test";
import { loadPolicy, PolicyError } from "./policy.ts";

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

test.each([
  ["routes:\n  review: { effort: extreme }\n", /\.verdandi\/routing\.yaml: [\s\S]*\["routes"\]\["review"\]\["effort"\]/],
  ["routes:\n  code.magic: { effort: low }\n", /\.verdandi\/routing\.yaml: [\s\S]*\["routes"\]\["code\.magic"\]/],
  ["modes: thrifty\n", /\.verdandi\/routing\.yaml: [\s\S]*\["modes"\]/],
  [
    "routes:\n  review: { prefer: [cc-gpt] }\n",
    '.verdandi/routing.yaml: routes.review.prefer: unknown target "cc-gpt"; define it under targets.',
  ],
  [
    "targets:\n  cc-mini: { harness: claude-code, provider: claude-subscription, model: mini }\n",
    ".verdandi/routing.yaml: targets.cc-mini: model mini from claude-subscription on claude-code isn't in the model catalog.",
  ],
])("bad policy fails loudly, naming the file and the key: %s", (yaml, message) => {
  expect(() => loadPolicy([project(yaml)])).toThrow(PolicyError);
  expect(() => loadPolicy([project(yaml)])).toThrow(message);
});
