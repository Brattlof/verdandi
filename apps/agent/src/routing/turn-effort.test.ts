import { expect, test } from "bun:test";
import type { CatalogEntry, Route, RouteDecision } from "@verdandi/contracts";
import { nativeCatalog } from "@verdandi/harness-native";
import { loadPolicy } from "@verdandi/router";
import { Result } from "effect";
import { catalogFor, decideTurnEffort } from "./routing.ts";

/** A model on an OpenAI-compatible endpoint, which takes effort only per request (ADR 0035). */
const coder: CatalogEntry = {
  harness: "native",
  provider: "openrouter",
  model: "qwen/qwen3-coder",
  access: "metered",
  tier: "M",
  context: 262_144,
  vision: false,
  efforts: ["low", "medium", "high"],
  price: { input: 0.2, output: 0.8, cacheRead: 0.2, cacheWrite: 0.2 },
};
const catalog = catalogFor({ native: { catalog: [...nativeCatalog, coder] }, fake: {} });
const routing = (data: unknown = {}) => ({
  policy: Result.succeed(loadPolicy([{ source: "routing.yaml", data }], catalog)),
  builtIn: loadPolicy([], catalog),
  harnesses: ["native", "claude-code"] as const,
});
const native: Route = { harness: "native", model: "claude-sonnet-5-5", effort: "medium" };
const thread = (route: Route, more: { pinned?: boolean; source?: RouteDecision["source"] } = {}) => ({
  route,
  pinned: more.pinned ?? false,
  budgetMode: null,
  sessionId: "session",
  cachedTokens: 0,
  untrusted: null,
  taskDecision: {
    source: more.source ?? "policy",
    taskClass: "code.edit.local",
    difficulty: 0.3,
    confidence: 0.9,
    target: { harness: route.harness, provider: "anthropic", model: route.model, access: "metered" },
    effort: route.effort,
    reason: "",
    trace: [],
  } satisfies RouteDecision,
});

test("a light turn on the native harness runs at its own effort; on Claude Code, or a pinned route, it keeps the task's", () => {
  expect(decideTurnEffort(thread(native), routing(), "go ahead", undefined)?.effort).toBe("low");
  expect(
    decideTurnEffort(thread({ ...native, harness: "claude-code", model: "sonnet" }), routing(), "go ahead", undefined),
  ).toBeUndefined();
  expect(decideTurnEffort(thread(native, { pinned: true }), routing(), "go ahead", undefined)).toBeUndefined();
  expect(decideTurnEffort(thread(native, { source: "pin" }), routing(), "go ahead", undefined)).toBeUndefined();
  // An endpoint's model would break its cache changing effort mid-session, so it keeps the task's.
  expect(decideTurnEffort(thread({ ...native, model: coder.model }), routing(), "go ahead", undefined)).toBeUndefined();
});

test("the class's effortBand sets the band, the fallback's applies to classes that set none, and 0 turns it off", () => {
  const trace = "It crashes:\nTypeError: x\n    at f (src/a.ts:1:1)";
  const wide = routing({ fallback: { effortBand: 2 } });
  expect(decideTurnEffort(thread(native), wide, trace, "failed")?.effort).toBe("xhigh");
  const off = routing({ routes: { "code.edit.local": { effortBand: 0 } }, fallback: { effortBand: 2 } });
  expect(decideTurnEffort(thread(native), off, trace, "failed")).toBeUndefined();
});

test("a bad effortBand fails loading, naming the key", () => {
  expect(() => loadPolicy([{ source: "routing.yaml", data: { routes: { review: { effortBand: 9 } } } }], catalog)).toThrow(
    /routing\.yaml: [\s\S]*\["routes"\]\["review"\]\["effortBand"\]/,
  );
});
