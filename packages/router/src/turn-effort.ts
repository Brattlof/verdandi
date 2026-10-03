import { Effort } from "@verdandi/contracts";
import { clampEffort } from "./policy.ts";
import { signals } from "./signals.ts";

export type TurnEffortInput = {
  /** The turn's message. */
  readonly text: string;
  /** The task's route effort, which the band is around. */
  readonly effort: Effort;
  /** The effort levels the turn's model takes; none turns auto effort off. */
  readonly efforts: readonly Effort[];
  /** How many levels either side of `effort` a turn may move (the class's `effortBand`); 0 turns it off. */
  readonly band: number;
  /** How the task's last turn's verifiers went, when it ran any. */
  readonly verifiers?: "passed" | "failed";
};

/** A reply that only confirms or waves the agent on: "yes", "go ahead", "looks good". */
const CONFIRMATION =
  /^(y|yes|yep|yeah|ok|okay|sure|please|go|go on|go ahead|continue|proceed|do it|sounds good|looks good|lgtm|perfect|great|thanks|thank you)( please| thanks)?[.!]*$/;
const COMMIT = /\bcommit\b/;

const levels = Effort.literals;

/**
 * Pure: the effort a turn of a running task runs at (DESIGN §8.7 auto effort), from the same cheap local signals as
 * routing's stage 2, with no model call. Heavy turns go up: one level per signal (a stack trace, a failed verifier), or
 * to the band's top when the text asks for depth ("think hard"). Light ones go down: one level (a confirmation, a commit
 * after the verifiers passed), or to the band's bottom when it asks for speed. Within `band` levels of the task's
 * effort and the model's levels. Undefined when the turn stays at the task's effort: plain, mixed, or at the band's edge.
 */
export const turnEffort = (input: TurnEffortInput): { readonly effort: Effort; readonly reason: string } | undefined => {
  if (input.band <= 0 || input.efforts.length === 0) return undefined;
  const sig = signals(input.text, "build");
  const text = sig.text.trim();
  const heavy = [
    ...(sig.stackTrace ? ["a stack trace"] : []),
    ...(input.verifiers === "failed" ? ["the last turn's verifier failed"] : []),
    ...(sig.depth === "deep" ? ["it asks for depth"] : []),
  ];
  const light = [
    ...(CONFIRMATION.test(text) ? ["a confirmation"] : []),
    ...(input.verifiers === "passed" && COMMIT.test(text) ? ["a commit after the verifiers passed"] : []),
    ...(sig.depth === "quick" ? ["it asks for speed"] : []),
  ];
  if (heavy.length > 0 === light.length > 0) return undefined;
  const at = levels.indexOf(input.effort);
  const top = Math.min(levels.length - 1, at + input.band);
  const bottom = Math.max(0, at - input.band);
  const wanted =
    heavy.length > 0
      ? sig.depth === "deep"
        ? top
        : Math.min(top, at + heavy.length)
      : sig.depth === "quick"
        ? bottom
        : Math.max(bottom, at - light.length);
  const target = levels[wanted];
  const effort = target && clampEffort(input.efforts, target);
  // The model may lack the level: its nearest one must still move the right way, inside the band.
  const moved = effort ? levels.indexOf(effort) - at : 0;
  if (!effort || (heavy.length > 0 ? moved <= 0 : moved >= 0) || Math.abs(moved) > input.band) return undefined;
  const steps = Math.abs(moved);
  const signs = heavy.length > 0 ? heavy : light;
  return {
    effort,
    reason: `This turn looks ${heavy.length > 0 ? "heavy" : "light"} (${signs.join(", ")}), so it runs at ${effort} effort, ${steps === 1 ? "one level" : `${steps} levels`} ${heavy.length > 0 ? "above" : "below"} the task's ${input.effort}.`,
  };
};
