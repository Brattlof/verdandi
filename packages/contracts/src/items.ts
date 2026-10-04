import { Schema } from "effect";
import { TurnId } from "./ids.ts";
import { Effort, HarnessId, Route } from "./route.ts";
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
 * Untrusted text Verdandi puts in front of the agent (DESIGN §17): what an escalation's trigger hands its turn (a
 * verifier's output, the agent's own blocked reason, a repeated tool error), a Verdandi tool's result, the summary a
 * harness handoff seeds a new session with, a compression's summary, an `mcp` tool's result (from an MCP server the
 * native harness connects to, DESIGN §9.4), or a `context` file (a context or skill file a harness loads by itself, or
 * one the native harness puts in its prompt), or a scheduled job's pre-run `script` output (DESIGN §15). A `correction` escalation hands nothing: the user's own message is the turn.
 */
export const HandedSource = Schema.Literals([
  "verifier",
  "blocked",
  "repeated-error",
  "session_search",
  "memory_search",
  "handoff",
  "compression",
  "skills_list",
  "skill_view",
  "context",
  "mcp",
  "script",
]);
export type HandedSource = typeof HandedSource.Type;
/** What each source is, for the user. */
export const handedSourceLabel: Record<HandedSource, string> = {
  verifier: "the verifier's output",
  blocked: "the agent's blocked report",
  "repeated-error": "the repeated tool error",
  session_search: "a session_search result",
  memory_search: "a memory_search result",
  handoff: "the handoff summary",
  compression: "the compression summary",
  skills_list: "a skills_list result",
  skill_view: "a skill_view result",
  context: "a context file",
  mcp: "an MCP tool's result",
  script: "a scheduled job's pre-run script output",
};

/** How a flagged injection is introduced to the user, before its `why`: the same in the web UI and the terminal. */
export const injectionLead = (item: { readonly source: HandedSource; readonly file?: string; readonly withheld?: boolean }) =>
  item.withheld
    ? `Possible prompt injection in ${item.file ?? handedSourceLabel[item.source]}, left out of the agent's context:`
    : item.source === "context"
      ? `Possible prompt injection in ${item.file ?? "a context file"}, which the harness loads into the agent's context:`
      : `Possible prompt injection in ${handedSourceLabel[item.source]}, handed to the agent under a warning:`;

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
  /**
   * The native agent's `delegate_task` call `parentToolUseId` runs its subtask in a child session on `route`, routed as
   * a task of its own for `reason` (DESIGN §9.4). The child's steps carry the same `parentToolUseId`.
   */
  Schema.Struct({ kind: Schema.Literal("delegation"), route: Route, reason: Schema.String, parentToolUseId }),
  /**
   * The native harness compressed the session before this turn's next request (DESIGN §16): from about `tokensBefore`
   * tokens to about `tokensAfter`, by moving `pruned` tool results to disk and, when `summarized`, a summary of the
   * conversation before a recent tail, an `aux.compress` task that cost `costUsd`.
   */
  Schema.Struct({
    kind: Schema.Literal("compression"),
    tokensBefore: Schema.Number,
    tokensAfter: Schema.Number,
    pruned: Schema.Number,
    summarized: Schema.Boolean,
    costUsd: Schema.Number,
  }),
  /** Auto effort ran this turn at `to` instead of its task's `from` (DESIGN §8.7): a light or heavy turn. */
  Schema.Struct({ kind: Schema.Literal("effort"), from: Effort, to: Effort, reason: Schema.String }),
  /** Verdandi ran a project verifier after the agent finished changing files. */
  Schema.Struct({ kind: Schema.Literal("verifier"), ...VerifierRun.fields }),
  /** The agent reported, through Verdandi's `report_blocked` tool, that it can't finish the task as asked. */
  Schema.Struct({ kind: Schema.Literal("blocked"), reason: Schema.String }),
  /**
   * Verdandi's injection scan flagged text from `source` it handed the agent in this turn, or in the turn it sent after
   * it (an escalation's). The agent got it under a warning; `why` is what the scan saw. A `context` flag names its
   * `file`; `withheld` when the text never reached the agent (the native harness leaves a flagged file out).
   */
  Schema.Struct({
    kind: Schema.Literal("injection"),
    source: HandedSource,
    why: Schema.String,
    file: Schema.optionalKey(Schema.String),
    withheld: Schema.optionalKey(Schema.Boolean),
  }),
  /**
   * The thread moved from a `from` session to a new `to` one, and this turn's agent starts from `summary`, written by an
   * `aux.handoff` task over the thread so far (DESIGN §8.2 lever 5): what was carried over, shown to the user.
   */
  Schema.Struct({ kind: Schema.Literal("handoff"), from: HarnessId, to: HarnessId, summary: Schema.String }),
  /**
   * Smart approvals (DESIGN §17) decided tool call `toolUseId` without asking the user: `allow` ran it, `deny` refused
   * it and told the agent `reason`.
   */
  Schema.Struct({
    kind: Schema.Literal("approval.auto"),
    toolUseId: Schema.String,
    decision: Schema.Literals(["allow", "deny"]),
    reason: Schema.String,
  }),
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

/** A compression on a turn, as the user reads it: the same in the web UI and the terminal (DESIGN §16). */
export const describeCompression = (item: Extract<Item, { kind: "compression" }>) => {
  const k = (n: number) => `${Math.round(n / 1000)}K`;
  const moved = item.pruned > 0 ? `moved ${item.pruned} tool result${item.pruned === 1 ? "" : "s"} to disk` : "";
  const summed = item.summarized ? `summarized the earlier conversation for $${item.costUsd.toFixed(2)}` : "";
  return `Compressed the session from about ${k(item.tokensBefore)} to ${k(item.tokensAfter)} tokens: ${[moved, summed].filter(Boolean).join(" and ")}.`;
};
