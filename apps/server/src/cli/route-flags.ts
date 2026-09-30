import { Route } from "@verdandi/contracts";
import { Schema } from "effect";
import { flag } from "../config/home.ts";

const defaultRoute: Route = { harness: "claude-code", model: "sonnet", effort: "medium" };

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

/** What differs between two routes, e.g. `model sonnet → opus, effort medium → high`; empty when nothing does. */
export const describeRouteChange = (from: Route, to: Route) =>
  (["harness", "model", "effort"] as const)
    .filter((k) => from[k] !== to[k])
    .map((k) => `${k} ${from[k]} → ${to[k]}`)
    .join(", ");
