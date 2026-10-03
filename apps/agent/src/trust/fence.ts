import type { DecisionAnswer } from "@verdandi/contracts";
import { flagged, injectionWarning } from "@verdandi/decisions";

/**
 * Untrusted `text` as Verdandi hands it to the agent in a user message: in a fence longer than any run of backticks in
 * it, so it can't close the fence, under a warning when the injection scan's `answer` flags it (DESIGN §17, ADR 0025).
 * Every piece of untrusted text a user message carries goes through here: escalation hand-offs, the review digest and
 * the memory snapshot. Pure and deterministic, so the decider can use it.
 */
export const asData = (text: string, answer: DecisionAnswer | undefined) => {
  const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return [...(answer && flagged(answer) ? [injectionWarning] : []), fence, text, fence];
};
