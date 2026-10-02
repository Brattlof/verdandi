import { type CatalogEntry, Effort, type HarnessId, type RouteTarget, type Tier } from "@verdandi/contracts";
import { clampEffort, type ResolvedPolicy } from "./policy.ts";

export type EscalationInput = {
  /** The task's route now. */
  readonly target: RouteTarget;
  readonly effort: Effort;
  /** How many steps the task has already taken. */
  readonly escalations: number;
  /** What failed, as a sentence fragment, e.g. "`bun test` failed (exit 1)". */
  readonly failure: string;
  /** The harnesses verdandid runs; a stronger model on any other doesn't count. Absent, every harness counts. */
  readonly harnesses?: readonly HarnessId[];
};

export type Escalation =
  | { readonly step: "effort" | "model"; readonly target: RouteTarget; readonly effort: Effort; readonly reason: string }
  | { readonly step: "ask"; readonly reason: string };

const level = (e: Effort) => Effort.literals.indexOf(e);
const TIERS: readonly Tier[] = ["S", "M", "L", "XL"];

/**
 * Pure: the next step of the escalation ladder (DESIGN §8.7) for a routed task whose verifier failed. Steps follow
 * the policy's `ladder`, one per failure, skipping one that can't apply (no higher effort level the model takes, no
 * stronger model on the task's harness). Once the task has taken `maxAutoEscalations` steps, or the ladder runs out or reaches `ask`, it asks.
 * A stronger model stays on the task's harness, so the session and its context carry over.
 */
export const escalate = (input: EscalationInput, policy: ResolvedPolicy): Escalation => {
  const { ladder, maxAutoEscalations } = policy.escalation;
  const ask = (why: string): Escalation => ({
    step: "ask",
    reason: `${input.failure}, and ${why}, so Verdandi leaves the next step to you: send a follow-up, or pick a stronger route.`,
  });
  if (input.escalations >= maxAutoEscalations) {
    const n = input.escalations;
    return ask(`this task already escalated ${n === 1 ? "once" : `${n} times`} (maxAutoEscalations ${maxAutoEscalations})`);
  }
  const entryOf = (t: RouteTarget) =>
    policy.catalog.find((e) => e.harness === t.harness && e.provider === t.provider && e.model === t.model);
  for (const step of ladder.slice(input.escalations)) {
    if (step === "ask") return ask("the escalation ladder says to ask you");
    if (step === "effort") {
      // A model without effort levels, or one the catalog doesn't know, has no level to raise to.
      const next = entryOf(input.target)?.efforts.find((e) => level(e) > level(input.effort));
      if (next)
        return {
          step,
          target: input.target,
          effort: next,
          reason: `${input.failure}, so the task goes on at ${next} effort, one step up from ${input.effort}.`,
        };
      continue;
    }
    const current = entryOf(input.target)?.tier;
    if (!current) continue;
    const stronger = [...policy.targets.values()].filter(
      (t: CatalogEntry) =>
        t.harness === input.target.harness &&
        (!input.harnesses || input.harnesses.includes(t.harness)) &&
        TIERS.indexOf(t.tier) > TIERS.indexOf(current),
    );
    // The next tier up, cheapest first; ties go to the policy's order.
    const to = stronger.reduce<CatalogEntry | undefined>(
      (best, t) =>
        !best || TIERS.indexOf(t.tier) < TIERS.indexOf(best.tier) || (t.tier === best.tier && t.price.input < best.price.input) ? t : best,
      undefined,
    );
    if (to) {
      const { harness, provider, model, access } = to;
      const effort = clampEffort(to.efforts, input.effort);
      return {
        step,
        target: { harness, provider, model, access },
        effort: effort ?? input.effort,
        reason: `${input.failure}, so the task goes on on the stronger ${model}${effort ? ` at ${effort} effort` : ""}.`,
      };
    }
  }
  return ask("no stronger route is left on its harness");
};
