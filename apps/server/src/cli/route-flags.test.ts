import { describe, expect, test } from "bun:test";
import { describeRouteChange, type Route } from "@verdandi/contracts";
import { budgetFromFlags, picksRoute, routeFromFlags } from "./route-flags.ts";

const opusHigh: Route = { harness: "claude-code", model: "opus", effort: "high" };

describe("chat route flags", () => {
  test("flags on an existing thread change its route", () => {
    const current: Route = { harness: "claude-code", model: "sonnet", effort: "medium" };
    const wanted = routeFromFlags(["chat", "--model", "opus", "--effort", "high"], current);
    expect(wanted).toEqual(opusHigh);
    expect(describeRouteChange(current, wanted)).toBe("model sonnet → opus, effort medium → high");
  });

  test("no flags keep the thread's route instead of resetting it to the default", () => {
    const wanted = routeFromFlags(["chat"], opusHigh);
    expect(wanted).toEqual(opusHigh);
    expect(describeRouteChange(opusHigh, wanted)).toBe("");
  });

  test("only route flags pick a route; without them the router picks", () => {
    expect(picksRoute(["chat", "--effort", "high"])).toBe(true);
    expect(picksRoute(["chat", "--thread", "t1", "--auto"])).toBe(false);
  });

  test("an unknown effort fails loudly", () => {
    expect(() => routeFromFlags(["chat", "--effort", "extreme"])).toThrow();
  });

  test("--budget picks a mode, policy clears it, and anything else names the choices", () => {
    expect(budgetFromFlags(["chat", "--budget", "thrifty"])).toBe("thrifty");
    expect(budgetFromFlags(["chat", "--budget", "policy"])).toBeNull();
    expect(budgetFromFlags(["chat"])).toBeUndefined();
    expect(() => budgetFromFlags(["chat", "--budget", "cheap"])).toThrow("thrifty, balanced, max, or policy");
  });
});
