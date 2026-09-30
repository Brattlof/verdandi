import { describe, expect, test } from "bun:test";
import { describeRouteChange, type Route } from "@verdandi/contracts";
import { routeFromFlags } from "./route-flags.ts";

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

  test("an unknown effort fails loudly", () => {
    expect(() => routeFromFlags(["chat", "--effort", "extreme"])).toThrow();
  });
});
