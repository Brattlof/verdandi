import { Schema } from "effect";

export const Effort = Schema.Literals(["low", "medium", "high", "xhigh", "max"]);
export type Effort = typeof Effort.Type;

/**
 * How a turn may act: `ask` answers without changing anything, `plan` proposes a plan for the user
 * to approve, `build` does the work. Chosen per turn, so it only changes at turn boundaries.
 */
export const InteractionMode = Schema.Literals(["ask", "plan", "build"]);
export type InteractionMode = typeof InteractionMode.Type;

/**
 * How much a thread's agent may do without asking (DESIGN §17, ADR 0025): `ask` asks before every action its harness
 * gates, `auto` lets a guard approve what it rates safe and asks about the rest, `full` asks about nothing. A thread
 * someone other than the owner can write in always asks, and `full` holds at `auto` once the session has read untrusted input.
 */
export const AccessLevel = Schema.Literals(["ask", "auto", "full"]);
export type AccessLevel = typeof AccessLevel.Type;
/** What each access level lets the agent do, for every surface that offers the choice. */
export const accessHelp: Record<AccessLevel, string> = {
  ask: "the agent asks before running commands or working outside the thread's folder",
  auto: "a guard approves commands it rates safe and asks about the rest",
  full: "the agent asks about nothing, until it reads untrusted input, when it goes on at auto",
};

export const HarnessId = Schema.Literals(["claude-code", "native", "fake"]);
export type HarnessId = typeof HarnessId.Type;

/**
 * Subagent profiles the policy can route (DESIGN §8.2 lever 1): `explorer` searches the codebase read-only,
 * `reviewer` reviews a change. Each harness maps them to its own subagents.
 */
export const SubagentProfile = Schema.Literals(["explorer", "reviewer"]);
export type SubagentProfile = typeof SubagentProfile.Type;

/** A model and effort per subagent profile, on the harness of the route that holds them. Profiles left out keep the harness's default. */
export const SubagentRoutes = Schema.Record(SubagentProfile, Schema.optionalKey(Schema.Struct({ model: Schema.String, effort: Effort })));
export type SubagentRoutes = typeof SubagentRoutes.Type;

/**
 * The route a thread runs on. `subagents` is fixed for a harness session: the harness starts the session
 * with them, and a later task on that session keeps them. Absent on routes from before subagent routing,
 * on pins, and when the policy routes none.
 */
export const Route = Schema.Struct({
  harness: HarnessId,
  model: Schema.String,
  effort: Effort,
  subagents: Schema.optionalKey(SubagentRoutes),
});
export type Route = typeof Route.Type;

/** A new thread's route when nothing else picks one. */
export const defaultRoute: Route = { harness: "claude-code", model: "sonnet", effort: "medium" };

/**
 * A message's leading `@name` (DESIGN §12): the model it pins the task it starts to, and the text the agent sees
 * without it. Undefined when the message doesn't start with one. Whether `name` is a model is the router's call.
 */
export const atPin = (text: string) => {
  const m = /^\s*@(\S+)\s*/.exec(text);
  return m?.[1] === undefined ? undefined : { name: m[1], text: text.slice(m[0].length) };
};

/** What differs between two routes, e.g. `model sonnet → opus, effort medium → high`; empty when nothing does. */
export const describeRouteChange = (from: Route, to: Route) =>
  (["harness", "model", "effort"] as const)
    .filter((k) => from[k] !== to[k])
    .map((k) => `${k} ${from[k]} → ${to[k]}`)
    .join(", ");
