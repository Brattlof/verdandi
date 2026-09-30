import { defaultRoute, Route } from "@verdandi/contracts";
import { Schema } from "effect";
import { flag } from "../config/home.ts";

/** Whether the flags pick a route, which pins the thread to it. Without them the router picks each task's. */
export const picksRoute = (argv: readonly string[]) => ["--harness", "--model", "--effort"].some((f) => flag(argv, f) !== undefined);

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
