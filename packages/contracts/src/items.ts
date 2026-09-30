import { Schema } from "effect";
import { Route } from "./route.ts";

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
  /** The router moved the rest of the turn to another route when the user approved its plan (DESIGN §8.2 lever 3). */
  Schema.Struct({ kind: Schema.Literal("route.switch"), from: Route, to: Route, reason: Schema.String }),
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
export const Usage = Schema.Struct(UsageFields);
export type Usage = typeof Usage.Type;

/**
 * A subscription window as the harness last reported it (Claude Code: `rate_limit_event`, ADR 0005).
 * `usingOverage`: the window is used up and turns run on the account's extra usage, priced as metered.
 */
export const Quota = Schema.Struct({
  status: Schema.Literals(["allowed", "allowed_warning", "rejected"]),
  /** Which window, as the harness names it, e.g. Claude Code's `five_hour` or `seven_day`. */
  window: Schema.optionalKey(Schema.String),
  /** How much of the window is used, from 0 to 1. */
  utilization: Schema.optionalKey(Schema.Number),
  /** When the window resets, as an ISO timestamp. */
  resetsAt: Schema.optionalKey(Schema.String),
  usingOverage: Schema.Boolean,
});
export type Quota = typeof Quota.Type;
