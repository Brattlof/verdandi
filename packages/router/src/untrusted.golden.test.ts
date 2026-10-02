import { expect, test } from "bun:test";
import type { CatalogEntry, Effort, UntrustedInput } from "@verdandi/contracts";
import { deescalate } from "./deescalate.ts";
import { loadPolicy, PolicyError } from "./policy.ts";
import { route } from "./route.ts";
import { rules } from "./rules.ts";

// DESIGN §17: smaller models are easier to hijack, so while a warm session holds untrusted input and can write files
// or run commands, no route keeps that session below the built-in floor (`untrusted: { minTier: M, forbid: [local] }`).
const policy = loadPolicy();
const target = (model: string) => {
  const entry = policy.catalog.find((e) => e.model === model);
  if (!entry) throw new Error(`no ${model} in the catalog`);
  const { harness, provider, access } = entry;
  return { harness, provider, model, access };
};
const webFetch: UntrustedInput = { source: "WebFetch", turn: 3 };
const read = "this session read untrusted input (WebFetch, turn 3)";
const session = (model: string, effort: Effort, cachedTokens = 0) => ({ target: target(model), effort, cachedTokens });
const after = (model: string, effort: Effort, untrusted?: UntrustedInput) =>
  deescalate(
    { text: "Write a commit message for these changes", current: session(model, effort), ...(untrusted && { untrusted }) },
    policy,
    rules,
  );
const routed = (d: { target: { model: string }; effort: Effort } | undefined) => d && `${d.target.model} ${d.effort}`;

test("a session that read a WebFetch result stays on its route at a mechanical turn, and the reason names the source", () => {
  expect(routed(after("sonnet", "medium"))).toBe("haiku low");
  const d = after("sonnet", "medium", webFetch);
  expect(routed(d)).toBe("sonnet medium");
  expect(d?.reason).toBe(`The verifiers passed and what's left looks like chore.git, but ${read}, so it stays on sonnet at medium effort.`);
  expect(d?.trace.find((t) => t.stage === "candidates")?.note).toBe(`dropped cc-haiku: tier S is below M while ${read}`);
});

test("a tainted session still de-escalates, but no lower than the floor", () => {
  expect(routed(after("opus", "high"))).toBe("haiku low");
  const d = after("opus", "high", webFetch);
  expect(routed(d)).toBe("sonnet low");
  expect(d?.reason).toBe(`The verifiers passed and what's left looks like chore.git, but ${read}, so it runs on sonnet at low effort.`);
});

test("a new task keeps a tainted warm session at the floor, but a fresh session on another harness isn't held", () => {
  const ask = (untrusted?: UntrustedInput) =>
    route(
      { text: "Where is the auth middleware?", mode: "build", current: session("sonnet", "medium"), ...(untrusted && { untrusted }) },
      policy,
      rules,
    );
  expect(routed(ask())).toBe("haiku low");
  expect(ask(webFetch).reason).toBe(`Looks like ask.search ("where is"), but ${read}, so it stays on sonnet at low effort.`);

  // A cheap fake-harness model would start a new session, without the untrusted input.
  const fresh: CatalogEntry = { ...policy.catalog[0], harness: "fake", provider: "fake", model: "fake-s", access: "local" } as CatalogEntry;
  const layered = loadPolicy(
    [
      {
        source: "test",
        data: {
          targets: { "fake-s": { harness: "fake", provider: "fake", model: "fake-s" } },
          routes: { "ask.search": { prefer: ["fake-s"] } },
        },
      },
    ],
    [...policy.catalog, fresh],
  );
  const elsewhere = route(
    { text: "Where is the auth middleware?", mode: "build", current: session("sonnet", "medium"), untrusted: webFetch },
    layered,
    rules,
  );
  expect(routed(elsewhere)).toBe("fake-s low");
});

test("the floor forbids local models on the session's harness, and a pin overrides it", () => {
  const local: CatalogEntry = { ...policy.catalog[1], provider: "ollama", model: "qwen", access: "local" } as CatalogEntry;
  const layered = loadPolicy(
    [
      {
        source: "test",
        data: {
          targets: { local: { harness: "claude-code", provider: "ollama", model: "qwen" } },
          routes: { "chore.git": { prefer: ["local"] } },
        },
      },
    ],
    [...policy.catalog, local],
  );
  const commit = (untrusted?: UntrustedInput) =>
    route(
      {
        text: "Write a commit message for these changes",
        mode: "build",
        current: session("opus", "high"),
        ...(untrusted && { untrusted }),
      },
      layered,
      rules,
    );
  expect(commit().target.model).toBe("qwen");
  expect(commit(webFetch).target.model).not.toBe("qwen");
  expect(commit(webFetch).trace.find((t) => t.stage === "candidates")?.note).toContain(`local: local is forbidden while ${read}`);

  const pinned = route(
    {
      text: "Write a commit message",
      mode: "build",
      pin: { target: target("haiku"), effort: "low" },
      current: session("sonnet", "medium"),
      untrusted: webFetch,
    },
    policy,
    rules,
  );
  expect(routed(pinned)).toBe("haiku low");
});

test("a project's policy can raise the floor but not lower it, and a bad floor fails naming the key", () => {
  const floor = (data: unknown) => loadPolicy([{ source: ".verdandi/routing.yaml", data: { untrusted: data } }]).untrusted;
  expect(floor({ minTier: "S", forbid: [] })).toEqual({ minTier: "M", forbid: ["local"] });
  expect(floor({ minTier: "L", forbid: ["metered"] })).toEqual({ minTier: "L", forbid: ["local", "metered"] });
  expect(() => floor({ minTier: "Q" })).toThrow(PolicyError);
  expect(() => floor({ minTier: "Q" })).toThrow(/untrusted.*minTier/s);
});
