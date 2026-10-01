import { expect, test } from "bun:test";
import type { Effort, HarnessId } from "@verdandi/contracts";
import { escalate } from "./escalate.ts";
import { builtInCatalog, loadPolicy } from "./policy.ts";

const target = (model: string) => {
  const entry = builtInCatalog.find((e) => e.model === model);
  if (!entry) throw new Error(`no ${model} in the catalog`);
  const { harness, provider, access } = entry;
  return { harness, provider, model, access };
};
const failure = "`bun test` failed (exit 1)";
const step = (
  model: string,
  effort: Effort,
  escalations: number,
  escalation?: object,
  harnesses: readonly HarnessId[] = ["claude-code"],
) => {
  const policy = loadPolicy(escalation ? [{ source: "project", data: { escalation } }] : []);
  const e = escalate({ target: target(model), effort, escalations, failure, harnesses }, policy);
  return e.step === "ask" ? "ask" : `${e.step}: ${e.target.model} ${e.effort}`;
};

// The default ladder is effort, then model, then ask, and a task takes one step before asking (DESIGN §8.7).
test.each([
  ["sonnet", "medium", 0, undefined, "effort: sonnet high"],
  ["sonnet", "medium", 1, undefined, "ask"],
  // Effort already at its top: the effort step can't apply, so the next one does.
  ["sonnet", "max", 0, undefined, "model: opus max"],
  ["haiku", "max", 0, undefined, "model: sonnet max"],
  ["opus", "high", 1, { maxAutoEscalations: 2 }, "model: fable high"],
  ["fable", "max", 0, undefined, "ask"],
  ["sonnet", "low", 0, { ladder: ["model"] }, "model: opus low"],
  ["sonnet", "low", 0, { ladder: ["ask"] }, "ask"],
  ["sonnet", "low", 0, { maxAutoEscalations: 0 }, "ask"],
] as const)("%s at %s after %i steps with %o escalates to %s", (model, effort, escalations, escalation, expected) => {
  expect(step(model, effort, escalations, escalation)).toBe(expected);
});

test("a stronger model on a harness that isn't running doesn't count", () => {
  expect(step("sonnet", "max", 0, undefined, ["fake"])).toBe("ask");
});

test("each reason says what failed and what happens next", () => {
  const policy = loadPolicy();
  const first = escalate({ target: target("sonnet"), effort: "medium", escalations: 0, failure }, policy);
  expect(first.reason).toBe("`bun test` failed (exit 1), so the task goes on at high effort, one step up from medium.");
  const again = escalate({ target: target("sonnet"), effort: "high", escalations: 1, failure }, policy);
  expect(again.reason).toBe(
    "`bun test` failed (exit 1), and this task already escalated once (maxAutoEscalations 1), so Verdandi leaves the next step to you: send a follow-up, or pick a stronger route.",
  );
});
