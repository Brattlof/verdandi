import { expect, test } from "bun:test";
import type { BudgetMode, Effort } from "@verdandi/contracts";
import { deescalate } from "./deescalate.ts";
import { builtInCatalog, loadPolicy } from "./policy.ts";
import { rules } from "./rules.ts";

const target = (model: string) => {
  const entry = builtInCatalog.find((e) => e.model === model);
  if (!entry) throw new Error(`no ${model} in the catalog`);
  const { harness, provider, access } = entry;
  return { harness, provider, model, access };
};
const after = (text: string, model: string, effort: Effort, cachedTokens: number, mode: BudgetMode = "balanced") =>
  deescalate({ text, current: { target: target(model), effort, cachedTokens } }, loadPolicy([{ source: "test", data: { mode } }]), rules);
const routed = (d: ReturnType<typeof after>) => d && `${d.target.model} ${d.effort}`;
const gate = (d: ReturnType<typeof after>) => d?.trace.filter((t) => t.stage === "switch").map((t) => t.note);

// DESIGN §8.7: after the verifiers pass, mechanical work moves the rest of the task to its class's cheaper model,
// through the switch-cost gate. A small cached context is cheap to move; a large one isn't worth it for a chore.
test.each([
  ["Write a commit message for these changes", "opus", "high", 10_000, "balanced", "haiku low"],
  ["Write a commit message for these changes", "opus", "high", 150_000, "balanced", "opus high"],
  ["Rename getUser to fetchUser", "opus", "high", 0, "balanced", "sonnet low"],
  ["Rename getUser to fetchUser", "opus", "high", 0, "thrifty", "haiku low"],
  ["Update the CHANGELOG for this release", "opus", "medium", 0, "balanced", "sonnet low"],
  // Never up, and never effort alone: a chore whose class runs on the warm model or a stronger one stays put.
  ["Rename getUser to fetchUser", "sonnet", "medium", 0, "balanced", "sonnet medium"],
  ["Update the CHANGELOG for this release", "haiku", "low", 0, "balanced", "haiku low"],
] as const)("%s on %s at %s with %i cached tokens in %s goes on on %s", (text, model, effort, cached, mode, expected) => {
  expect(routed(after(text, model, effort, cached, mode))).toBe(expected);
});

test("a de-escalation the gate allows says the verifiers passed and what it saves", () => {
  const d = after("Write a commit message for these changes", "opus", "high", 10_000);
  expect(d).toMatchObject({ source: "policy", taskClass: "chore.git", target: { model: "haiku" }, effort: "low" });
  expect(d?.reason).toBe("The verifiers passed and what's left looks like chore.git, so it runs on haiku.");
  expect(gate(d)).toEqual(["switch: saves $0.005, more than the $0.003 to move 10K of context"]);
  expect(d?.estimate?.switchCost).toBeGreaterThan(0);
});

test("a de-escalation the gate blocks stays on the warm session at its effort, and the trace says why", () => {
  const d = after("Write a commit message for these changes", "opus", "high", 150_000);
  expect(d).toMatchObject({ taskClass: "chore.git", target: { model: "opus" }, effort: "high", estimate: { switchCost: 0 } });
  expect(d?.reason).toBe(
    "The verifiers passed and what's left looks like chore.git, which would run on haiku, but it stays on the warm opus session at high effort: switching would cost $0.04 to save $0.005.",
  );
  expect(gate(d)).toEqual(["stay: saves $0.005, less than the $0.04 to move 150K of context"]);
});

test("a chore whose class runs on no cheaper model stays put, and the trace says why", () => {
  const d = after("Rename getUser to fetchUser", "sonnet", "medium", 0);
  expect(d?.reason).toBe(
    "The verifiers passed and what's left looks like code.edit.mechanical, but no cheaper model takes it, so it stays on sonnet at medium effort.",
  );
  expect(gate(d)).toEqual(["stay: sonnet at low effort is no cheaper model than the task's sonnet"]);
});

test("work that isn't mechanical, or a turn the classifier isn't sure of, doesn't de-escalate", () => {
  expect(after("Fix the date parsing bug in src/dates.ts", "opus", "high", 0)).toBeUndefined();
  expect(after("hmm", "opus", "high", 0)).toBeUndefined();
});
