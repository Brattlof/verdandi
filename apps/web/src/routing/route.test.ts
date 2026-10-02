import { expect, test } from "bun:test";
import type { Route } from "@verdandi/contracts";
import { switchCost } from "./route.tsx";

const route: Route = { harness: "claude-code", model: "sonnet", effort: "medium" };
const warm = { route, sessionId: "s1", turns: [] };

test("a model or Claude Code effort change on a warm session warns of the cold cache", () => {
  expect(switchCost(warm, { ...route, model: "opus" })).toContain("cold cache write");
  expect(switchCost(warm, { ...route, effort: "high" })).toContain("cold cache write");
  expect(switchCost({ ...warm, sessionId: null }, { ...route, model: "opus" })).toBeUndefined();
});

test("an effort change costs nothing extra on the fake harness; a harness change starts a fresh session", () => {
  const fake: Route = { harness: "fake", model: "fake", effort: "low" };
  expect(switchCost({ ...warm, route: fake }, { ...fake, effort: "high" })).toBeUndefined();
  expect(switchCost(warm, { ...route, harness: "fake" })).toContain("fresh session");
});
