import {
  type CatalogEntry,
  describeFailure,
  type Effort,
  healthCovers,
  type ProviderHealth,
  type RouteTarget,
  type SpendCapped,
  spendsMetered,
  type TaskClass,
} from "@verdandi/contracts";
import { clampEffort, type ResolvedPolicy, resolveSpec } from "./policy.ts";

export type FallbackInput = {
  /** The route the turn ran on when its provider failed. */
  readonly target: RouteTarget;
  readonly effort: Effort;
  readonly failure: ProviderHealth;
  /** The task's class, from its route decision; without one, the policy's default route applies. */
  readonly taskClass?: TaskClass;
  /** The user chose the route: the thread's pin, or the task's leading `@name`. Such a route never falls back. */
  readonly pinned?: "thread" | "at";
  /** The turn fell back once already. */
  readonly fellBack?: boolean;
  /** Every failure in force besides `failure`. */
  readonly health?: readonly ProviderHealth[];
  /** A reached metered spend cap: a fallback that would spend metered dollars is refused. */
  readonly capped?: SpendCapped;
};

/** Where the turn goes on, with why; or, without a `target`, why it stops. */
export type Fallback = { readonly target: RouteTarget; readonly effort: Effort; readonly reason: string } | { readonly reason: string };

/** Failures another target can't help with: billing needs the user, and an overflow is the conversation's size (#186). */
const stops: Partial<Record<ProviderHealth["reason"], (f: ProviderHealth) => string>> = {
  billing: (f) =>
    `which needs you: settle it with ${f.provider}, or pick another route. Verdandi doesn't move the turn's spend to another account`,
  context_overflow: () => "another model can't hold it either: start a new thread",
};

/**
 * Pure: where a turn goes on when its provider failed (DESIGN §9.5): the first healthy target on the turn's harness that
 * its task's class route accepts, in the policy's order, else the first its default route accepts; for this turn only.
 * A route the user chose, a billing failure, an overflow, a second failure in one turn, and a reached spend cap in the
 * way of a metered target all stop the turn instead, with the reason naming why.
 */
export const fallback = (input: FallbackInput, policy: ResolvedPolicy): Fallback => {
  const { failure, target } = input;
  const failed = describeFailure(failure);
  const stop = (why: string): Fallback => ({ reason: `${failed}, ${why}.` });
  if (input.pinned === "thread") return stop("and you picked this route, so Verdandi doesn't move it: pick another route to go on");
  if (input.pinned === "at")
    return stop(`and you pinned this task to it with @${target.model}, so Verdandi doesn't move it: pick another route to go on`);
  const stopping = stops[failure.reason];
  if (stopping) return stop(stopping(failure));
  if (input.fellBack) return stop("and this turn fell back once already, so it stops here: try again shortly, or pick another route");
  const sick = [failure, ...(input.health ?? [])];
  const capped: CatalogEntry[] = [];
  const usable = (name: string) => {
    const t = policy.targets.get(name);
    if (!t || t.harness !== target.harness || sick.some((h) => healthCovers(h, t.provider, t.model))) return undefined;
    if (input.capped && spendsMetered(t, input.capped.paying)) return void capped.push(t);
    return t;
  };
  const first = (names: readonly string[] | undefined) => (names ?? []).map(usable).find((t) => t !== undefined);
  const rule = input.taskClass && policy.routes[input.taskClass];
  const own = rule ? first(resolveSpec(rule, policy.mode, false).prefer) : undefined;
  const pick = own ?? first(resolveSpec(policy.fallback, policy.mode, false).prefer);
  if (!pick) {
    const [metered] = capped;
    if (metered && input.capped)
      return stop(
        `and the ${input.capped.cap} of metered spend is reached, so Verdandi doesn't fall back to the metered ${metered.model}: raise the cap, or pick another route`,
      );
    const routes = rule ? `${input.taskClass}'s route or the default route` : "the default route";
    return stop(`and no other healthy target on ${target.harness} is on ${routes}: try again later, or pick another route`);
  }
  const effort = clampEffort(pick.efforts, input.effort);
  const { harness, provider, model, access } = pick;
  return {
    target: { harness, provider, model, access },
    effort: effort ?? input.effort,
    reason: `${failed}, so this turn falls back to ${model}${effort ? ` at ${effort} effort` : ""}, from ${own ? `${input.taskClass}'s route` : "the default route"}.`,
  };
};
