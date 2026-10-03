import { expect, test } from "bun:test";
import { Effort } from "@verdandi/contracts";
import { turnEffort } from "./turn-effort.ts";

const all = Effort.literals;
const at = (text: string, more: Partial<Parameters<typeof turnEffort>[0]> = {}) =>
  turnEffort({ text, effort: "medium", efforts: all, band: 1, ...more });

test("a light turn goes one level down", () => {
  expect(at("go ahead")).toEqual({
    effort: "low",
    reason: "This turn looks light (a confirmation), so it runs at low effort, one level below the task's medium.",
  });
  expect(at("Commit it", { verifiers: "passed" })).toEqual({
    effort: "low",
    reason: "This turn looks light (a commit after the verifiers passed), so it runs at low effort, one level below the task's medium.",
  });
});

test("a heavy turn goes up, one level per signal, or to the band's top when it asks for depth", () => {
  const trace = "It crashes:\nTypeError: x is undefined\n    at parse (src/parse.ts:12:5)";
  expect(at(trace)).toEqual({
    effort: "high",
    reason: "This turn looks heavy (a stack trace), so it runs at high effort, one level above the task's medium.",
  });
  expect(at(trace, { verifiers: "failed", band: 2 })).toEqual({
    effort: "xhigh",
    reason:
      "This turn looks heavy (a stack trace, the last turn's verifier failed), so it runs at xhigh effort, 2 levels above the task's medium.",
  });
  expect(at("Think hard about why the cache misses", { band: 2 })?.effort).toBe("xhigh");
});

test("a plain turn, or one that is both light and heavy, stays at the task's effort", () => {
  expect(at("Now add a --since flag to the export command")).toBeUndefined();
  expect(at("Quickly, before lunch:\nTypeError: x is undefined\n    at parse (src/parse.ts:12:5)")).toBeUndefined();
});

test("the band's edges hold: no lower than its bottom, no higher than its top, none at all when it's 0", () => {
  expect(at("go ahead", { effort: "low" })).toBeUndefined();
  expect(at("Think hard about it", { effort: "max" })).toBeUndefined();
  expect(at("Think hard about it", { band: 1 })?.effort).toBe("high");
  expect(at("go ahead", { band: 0 })).toBeUndefined();
});

test("a model's levels hold too: one without the next level up stays, one without effort levels never moves", () => {
  expect(at("Think hard about it", { effort: "high", efforts: ["low", "medium", "high"] })).toBeUndefined();
  expect(at("go ahead", { efforts: [] })).toBeUndefined();
});
