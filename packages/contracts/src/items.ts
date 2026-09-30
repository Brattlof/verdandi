import { Schema } from "effect";

/** A persisted piece of a turn. Text deltas are never items: they are broadcast and dropped. */
export const Item = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("assistant.message"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("tool.call"), toolUseId: Schema.String, name: Schema.String, input: Schema.Unknown }),
  Schema.Struct({ kind: Schema.Literal("tool.result"), toolUseId: Schema.String, isError: Schema.Boolean, content: Schema.String }),
  /** A message the user sent while the turn ran, recorded when Verdandi accepted it. */
  Schema.Struct({ kind: Schema.Literal("user.steer"), text: Schema.String }),
]);
export type Item = typeof Item.Type;

export const AccessMode = Schema.Literals(["subscription", "metered"]);
export type AccessMode = typeof AccessMode.Type;

/** One model's usage for one turn: per-turn numbers, never cumulative. */
export const UsageFields = {
  model: Schema.String,
  accessMode: AccessMode,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  costUsd: Schema.Number,
};
