import { Schema } from "effect";

/** One question a harness asks the user (Claude Code's `AskUserQuestion`). */
export const Question = Schema.Struct({
  question: Schema.String,
  header: Schema.String,
  options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })),
  multiSelect: Schema.Boolean,
});
export type Question = typeof Question.Type;

/**
 * How the user answered a request. Approvals take `allow` or `deny`; user-input requests take
 * `answer` or `deny`. `answers` maps each question's text to its answer; multi-select answers are
 * the chosen labels joined with ", ".
 */
export const Resolution = Schema.Union([
  Schema.Struct({ decision: Schema.Literal("allow") }),
  Schema.Struct({ decision: Schema.Literal("deny") }),
  Schema.Struct({ decision: Schema.Literal("answer"), answers: Schema.Record(Schema.String, Schema.String) }),
]);
export type Resolution = typeof Resolution.Type;
