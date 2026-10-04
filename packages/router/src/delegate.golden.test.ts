import { expect, test } from "bun:test";
import type { CatalogEntry, Effort, RouteTarget } from "@verdandi/contracts";
import { loadPolicy } from "./policy.ts";
import { route } from "./route.ts";
import { rules } from "./rules.ts";

// DESIGN §9.4: the native agent's delegate_task runs a subtask in a child session on the delegating turn's harness,
// routed as a task of its own, so a frontier model can plan while cheap models do the work (§8.2 lever 1).
const builtIn = loadPolicy();
const native = (model: string, from: string): CatalogEntry => {
  const entry = builtIn.catalog.find((e) => e.model === from);
  if (!entry) throw new Error(`no ${from} in the catalog`);
  return { ...entry, harness: "native", provider: "anthropic", model, access: "metered" };
};
const catalog = [...builtIn.catalog, native("n-haiku", "haiku"), native("n-sonnet", "sonnet"), native("n-opus", "opus")];
const target = (model: string): RouteTarget => {
  const entry = catalog.find((e) => e.model === model);
  if (!entry) throw new Error(`no ${model}`);
  const { harness, provider, access } = entry;
  return { harness, provider, model, access };
};
const opus = { target: target("n-opus"), effort: "high" as Effort };
/** A project that routes its search to native Haiku and the rest to native Sonnet, as `.verdandi/routing.yaml` would. */
const project = loadPolicy(
  [
    {
      source: ".verdandi/routing.yaml",
      data: {
        targets: {
          "n-haiku": { harness: "native", provider: "anthropic", model: "n-haiku" },
          "n-sonnet": { harness: "native", provider: "anthropic", model: "n-sonnet" },
        },
        routes: { "ask.search": { prefer: ["n-haiku"] } },
        fallback: { prefer: ["n-sonnet"] },
      },
    },
  ],
  catalog,
);
const delegated = (text: string, more: Partial<Parameters<typeof route>[0]> = {}, policy = project) =>
  route({ text, mode: "build", harnesses: ["native"], parent: opus, ...more }, policy, rules);

test("a delegated search runs on the cheap model the project's policy names for its class, on the parent's harness", () => {
  const d = delegated("Where is the auth middleware?");
  expect(`${d.target.harness} ${d.target.model}`).toBe("native n-haiku");
  expect(d.source).toBe("policy");
  expect(d.reason).toBe('Looks like ask.search ("where is"), so it runs on n-haiku.');
});

test("with no target of the policy on the parent's harness, the subtask runs where the parent does", () => {
  const d = delegated("Where is the auth middleware?", {}, loadPolicy([], catalog));
  expect(`${d.target.model} ${d.effort}`).toBe("n-opus high");
  expect(d.reason).toBe(
    "No target in the policy is available for this ask.search subtask, so it runs on the delegating agent's n-opus at high effort.",
  );
  expect(d.trace.find((t) => t.stage === "candidates")?.note).toContain("cc-haiku: the claude-code harness isn't running");
  // Anything else still fails, naming why each target dropped out.
  expect(() => route({ text: "Where is it?", mode: "build", harnesses: ["native"] }, loadPolicy([], catalog), rules)).toThrow(
    "No target is available",
  );
});

test("a subtask naming a profile runs on the parent route's subagent route, unrouted", () => {
  const d = delegated("Review the diff for missed error handling", {
    profile: { name: "reviewer", target: target("n-sonnet"), effort: "low" },
  });
  expect(`${d.target.model} ${d.effort}`).toBe("n-sonnet low");
  expect(d.source).toBe("policy");
  expect(d.reason).toBe("The route's reviewer runs on n-sonnet at low effort.");
  expect(d.trace[0]).toEqual({ stage: "pin", note: "the route's reviewer subagent: native · n-sonnet · low; routing skipped" });
});

test("a subtask delegated from a session that read untrusted input goes no lower than the floor", () => {
  const d = delegated("Where is the auth middleware?", { untrusted: { source: "WebFetch", turn: 2 } });
  const read = "the session that delegated it read untrusted input (WebFetch, turn 2)";
  expect(d.target.model).toBe("n-sonnet");
  expect(d.reason).toBe(`Looks like ask.search ("where is"), but ${read}, so it runs on n-sonnet at low effort.`);
  expect(d.trace.find((t) => t.stage === "candidates")?.note).toContain(`n-haiku: tier S is below M while ${read}`);
});
