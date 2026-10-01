import { Schema } from "effect";
import { InteractionMode, Route } from "./route.ts";

/**
 * One task of an eval set (DESIGN §8.10): a prompt run on `repo` at `commit`, graded by `verify`, a command whose
 * exit code says whether the work is right. `verify` is also the task's project verifier, so a routed run can escalate.
 */
export const EvalTask = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[\w.-]+$/)),
  /** A local git repository, relative to the eval set's file. */
  repo: Schema.String,
  /** The full commit SHA the task starts from. */
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  prompt: Schema.String,
  verify: Schema.String,
  /** Runs before the agent, e.g. `bun install`. A task whose setup fails isn't run. */
  setup: Schema.optionalKey(Schema.String),
  /** Defaults to `build`. */
  mode: Schema.optionalKey(InteractionMode),
});
export type EvalTask = typeof EvalTask.Type;

/** An eval set file, e.g. `evals/m2.yaml`. Unknown keys are errors. */
export const EvalSet = Schema.Struct({ tasks: Schema.NonEmptyArray(EvalTask) });
export type EvalSet = typeof EvalSet.Type;

/** How one task went on one route of a batch run. `costUsd` is every turn's cost at API prices, subscription turns included. */
export const BatchResult = Schema.Struct({
  task: Schema.String,
  /** `auto` (the router picks) or a pinned route as `harness/model/effort`. */
  route: Schema.String,
  /** The route the task's first turn ran on. Absent when it never started. */
  ran: Schema.optionalKey(Route),
  /** Whether `verify` passed on the final tree. */
  passed: Schema.Boolean,
  costUsd: Schema.Number,
  meteredUsd: Schema.Number,
  turns: Schema.Int,
  escalations: Schema.Int,
  wallMs: Schema.Number,
  /** Why the task didn't run to the end: its setup failed, a spend cap stopped it, it timed out. */
  error: Schema.optionalKey(Schema.String),
});
export type BatchResult = typeof BatchResult.Type;

/** A batch run's report, written next to its database as `report.json`. */
export const BatchReport = Schema.Struct({
  v: Schema.Literal(1),
  evalSet: Schema.String,
  startedAt: Schema.String,
  results: Schema.Array(BatchResult),
});
export type BatchReport = typeof BatchReport.Type;
