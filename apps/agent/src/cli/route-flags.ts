import { BudgetMode, defaultRoute, Route } from "@verdandi/contracts";
import { Schema } from "effect";
import { flag } from "../home/home.ts";

/** Whether the flags pick a route, which pins the thread to it. Without them the router picks each task's. */
export const picksRoute = (argv: readonly string[]) => ["--harness", "--model", "--effort"].some((f) => flag(argv, f) !== undefined);

/**
 * The budget mode `--budget` asks for: `thrifty`, `balanced` or `max`, or `policy` (null) to use the
 * policy's again. Undefined when the flag is left out. Anything else fails loudly, naming the choices.
 */
export const budgetFromFlags = (argv: readonly string[]): BudgetMode | null | undefined => {
  const value = flag(argv, "--budget");
  if (value === undefined || value === "policy") return value === undefined ? undefined : null;
  if (Schema.is(BudgetMode)(value)) return value;
  throw new Error(`--budget takes thrifty, balanced, max, or policy to use the routing policy's mode; not "${value}".`);
};

/**
 * The route `verdandi chat` asks for: `--harness`, `--model` and `--effort` on top of the thread's
 * current route, or on top of the default for a new thread. Flags left out keep what the thread has.
 */
export const routeFromFlags = (argv: readonly string[], current: Route = defaultRoute): Route =>
  Schema.decodeUnknownSync(Route)({
    harness: flag(argv, "--harness") ?? current.harness,
    model: flag(argv, "--model") ?? current.model,
    effort: flag(argv, "--effort") ?? current.effort,
  });
