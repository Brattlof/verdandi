import { Schema } from "effect";
import { TurnId } from "./ids.ts";
import { Route } from "./route.ts";
import { EscalationStep } from "./routing.ts";

/** Set on a subagent's steps: the tool call that started the subagent. Absent on the main agent's. */
const parentToolUseId = Schema.optionalKey(Schema.String);

/**
 * One run of a project verifier (DESIGN §8.7): a command whose exit code tells whether the work is correct.
 * `exitCode` is null when it couldn't start or Verdandi stopped it. `output` is the tail of what it printed: untrusted data.
 */
export const VerifierRun = Schema.Struct({
  command: Schema.String,
  passed: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Number),
  durationMs: Schema.Number,
  output: Schema.String,
});
export type VerifierRun = typeof VerifierRun.Type;

/**
 * Untrusted text Verdandi itself hands the agent (DESIGN §17): what an escalation's trigger hands its turn (a
 * verifier's output, the agent's own blocked reason, a repeated tool error), or a Verdandi tool's result. A
 * `correction` escalation hands nothing: the user's own message is the turn.
 */
export const HandedSource = Schema.Literals(["verifier", "blocked", "repeated-error", "session_search", "memory_search"]);
export type HandedSource = typeof HandedSource.Type;
/** What each source is, for the user. */
export const handedSourceLabel: Record<HandedSource, string> = {
  verifier: "the verifier's output",
  blocked: "the agent's blocked report",
  "repeated-error": "the repeated tool error",
  session_search: "a session_search result",
  memory_search: "a memory_search result",
};

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
  /**
   * A plan the agent proposed for approval, raised as request `requestId`. `filePath` points at the harness's own
   * copy, when it keeps one. `edited` is the user's edit it was approved with, which the agent built from.
   */
  Schema.Struct({
    kind: Schema.Literal("plan"),
    requestId: Schema.optionalKey(Schema.String),
    text: Schema.String,
    filePath: Schema.optionalKey(Schema.String),
    edited: Schema.optionalKey(Schema.String),
  }),
  /** The router moved the rest of the turn to another route when the user approved its plan (DESIGN §8.2 lever 3). */
  Schema.Struct({ kind: Schema.Literal("route.switch"), from: Route, to: Route, reason: Schema.String }),
  /**
   * An escalation trigger fired on a routed task, and Verdandi escalated it (DESIGN §8.7): the task goes on at `to`,
   * starting with the turn `nextTurnId` Verdandi sent, or the user's own after a correction (no `nextTurnId`), or, at
   * `ask`, stops for the user. Both absent at `ask`. `requestId` is the plan whose rejection escalated this same turn.
   */
  Schema.Struct({
    kind: Schema.Literal("escalation"),
    step: EscalationStep,
    from: Route,
    to: Schema.optionalKey(Route),
    nextTurnId: Schema.optionalKey(TurnId),
    requestId: Schema.optionalKey(Schema.String),
    reason: Schema.String,
  }),
  /** Verdandi ran a project verifier after the agent finished changing files. */
  Schema.Struct({ kind: Schema.Literal("verifier"), ...VerifierRun.fields }),
  /** The agent reported, through Verdandi's `report_blocked` tool, that it can't finish the task as asked. */
  Schema.Struct({ kind: Schema.Literal("blocked"), reason: Schema.String }),
  /**
   * Verdandi's injection scan flagged text from `source` it handed the agent in this turn, or in the turn it sent after
   * it (an escalation's). The agent got it under a warning; `why` is what the scan saw.
   */
  Schema.Struct({ kind: Schema.Literal("injection"), source: HandedSource, why: Schema.String }),
  /** Something the harness or Verdandi tells the user about the turn, e.g. why a revert couldn't fork the conversation. */
  Schema.Struct({ kind: Schema.Literal("notice"), text: Schema.String }),
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
