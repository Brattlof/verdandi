import { Schema } from "effect";

export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
export type Effort = typeof Effort.Type;

/**
 * How a turn may act: `ask` answers without changing anything, `plan` proposes a plan for the user
 * to approve, `build` does the work. Chosen per turn, so it only changes at turn boundaries.
 */
export const InteractionMode = Schema.Literals(["ask", "plan", "build"]);
export type InteractionMode = typeof InteractionMode.Type;

export const HarnessId = Schema.Literals(["claude-code", "fake"]);
export type HarnessId = typeof HarnessId.Type;

/** The fixed route a thread runs on. The router (M2) will produce these. */
export const Route = Schema.Struct({ harness: HarnessId, model: Schema.String, effort: Effort });
export type Route = typeof Route.Type;

/** A new thread's route when nothing else picks one. */
export const defaultRoute: Route = { harness: "claude-code", model: "sonnet", effort: "medium" };

/** What differs between two routes, e.g. `model sonnet → opus, effort medium → high`; empty when nothing does. */
export const describeRouteChange = (from: Route, to: Route) =>
  (["harness", "model", "effort"] as const)
    .filter((k) => from[k] !== to[k])
    .map((k) => `${k} ${from[k]} → ${to[k]}`)
    .join(", ");
