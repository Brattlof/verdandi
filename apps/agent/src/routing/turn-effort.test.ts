import { expect, test } from "bun:test";
import type { Route, RouteDecision } from "@verdandi/contracts";
import { loadPolicy } from "@verdandi/router";
import { Result } from "effect";
import { catalogFor, decideTurnEffort } from "./routing.ts";

const catalog = catalogFor({ native: true, fake: true });
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
