import { Schema } from "effect";

export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
export type Effort = typeof Effort.Type;

export const HarnessId = Schema.Literals(["claude-code", "fake"]);
export type HarnessId = typeof HarnessId.Type;

/** The fixed route a thread runs on. The router (M2) will produce these. */
export const Route = Schema.Struct({ harness: HarnessId, model: Schema.String, effort: Effort });
export type Route = typeof Route.Type;
