import { Schema } from "effect";

/** Set on a subagent's steps: the tool call that started the subagent. Absent on the main agent's. */
const parentToolUseId = Schema.optionalKey(Schema.String);

/** A persisted piece of a turn. Text deltas are never items: they are broadcast and dropped. */
export const Item = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("assistant.message"), text: Schema.String, parentToolUseId }),
  Schema.Struct({
    kind: Schema.Literal("tool.call"),
    toolUseId: Schema.String,
    name: Schema.String,
    input: Schema.Unknown,
    parentToolUseId,
  }),
  Schema.Struct({
    kind: Schema.Literal("tool.result"),
    toolUseId: Schema.String,
    isError: Schema.Boolean,
    content: Schema.String,
    parentToolUseId,
  }),
  /** A message the user sent while the turn ran, recorded when Verdandi accepted it. */
  Schema.Struct({ kind: Schema.Literal("user.steer"), text: Schema.String }),
  /** A plan the agent proposed for approval. `filePath` points at the harness's own copy, when it keeps one. */
  Schema.Struct({ kind: Schema.Literal("plan"), text: Schema.String, filePath: Schema.optionalKey(Schema.String) }),
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
