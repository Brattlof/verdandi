import type { RouteDecision, TaskClass } from "@verdandi/contracts";
import type { ResolvedPolicy } from "./policy.ts";
import { type RouteInput, route } from "./route.ts";
import type { Classifier } from "./rules.ts";
import { signals } from "./signals.ts";

/** Work left after a build that a cheaper model finishes as well: commits, renames, changelogs (DESIGN §8.7). */
const MECHANICAL: ReadonlySet<TaskClass> = new Set(["chore.git", "code.edit.mechanical", "docs.write"]);

export type DeescalationInput = Pick<RouteInput, "text" | "providers" | "capped"> & {
  /** The task's route now, with what its session has cached (0 without one) and the subagents it keeps. */
  readonly current: NonNullable<RouteInput["current"]>;
};

/**
 * Pure: where the rest of a routed task goes when its last turn passed its verifiers and the next one, `text`, is
 * mechanical work (DESIGN §8.7). Undefined when that turn isn't mechanical, or the classifier isn't sure. Otherwise
 * the decision: the class's route when it is a less capable model on the task's harness and the switch-cost gate lets
 * the warm session go, else the task's own route, with the reason and trace saying why it stays.
 */
export const deescalate = (input: DeescalationInput, policy: ResolvedPolicy, classify: Classifier): RouteDecision | undefined => {
  const c = classify(signals(input.text, "build"));
  if ((c.lowConfidence ?? c.confidence < policy.minConfidence) || !MECHANICAL.has(c.taskClass)) return undefined;
  // The session and its context stay with the task's harness.
  return route({ ...input, mode: "build", verified: true, harnesses: [input.current.target.harness] }, policy, () => c);
};
