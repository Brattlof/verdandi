import { Data, type Effect, Schema, type Stream } from "effect";
import type { AttachmentRef } from "./attachments.ts";
import type { TaskId, ThreadId, TurnId } from "./ids.ts";
import { Item, Quota, UsageFields } from "./items.ts";
import { ProviderFailure } from "./provider-health.ts";
import { Question, type Resolution } from "./requests.ts";
import type { Effort, HarnessId, InteractionMode, Route } from "./route.ts";
import type { TaskLimits } from "./routing.ts";

/** What every harness adapter reports, normalized. */
export const HarnessEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("session.started"),
    sessionId: Schema.String,
    harnessVersion: Schema.String,
    /** Where the harness keeps the session's own transcript, when it keeps one in a file. */
    transcriptPath: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("text.delta"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("item"), item: Item }),
  Schema.Struct({ type: Schema.Literal("usage"), ...UsageFields }),
  /**
   * The main agent made a model round trip, what a task's `maxTurns` counts. Report each as it starts, and only when
   * the run has `limits.maxTurns`, so the count survives an interrupt or a new process.
   */
  Schema.Struct({ type: Schema.Literal("model.called") }),
  /** The subscription window changed. Report it only when it differs from the last one reported. */
  Schema.Struct({ type: Schema.Literal("quota"), quota: Quota }),
  /** The harness blocks until `respond` answers `requestId`. */
  Schema.Struct({ type: Schema.Literal("approval.requested"), requestId: Schema.String, toolName: Schema.String, input: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("user-input.requested"), requestId: Schema.String, questions: Schema.Array(Question) }),
  /** Allowing it leaves planning: the turn goes on building. Denying it keeps the agent planning. */
  Schema.Struct({
    type: Schema.Literal("plan.requested"),
    requestId: Schema.String,
    plan: Schema.String,
    filePath: Schema.optionalKey(Schema.String),
  }),
  /**
   * A model request failed once the provider's SDK stopped retrying (DESIGN §9.5), classified into the closed set of
   * `reason`s. `model` scopes it to that model when the provider's limits are per model, and is absent when the whole
   * provider failed; `until` (ISO) is when to try again, the provider's own reset when `reset`, else `failureCooldownMs`.
   * The harness blocks until `respond` answers `requestId`: allowing it means `reroute` has moved the turn to a fallback,
   * so it retries the request there; denying it ends the turn with an error naming the provider, the reason, `until`
   * and the denial's `feedback`, Verdandi's reason not to fall back. Native reports it; Claude Code doesn't (its
   * models share one subscription window, ADR 0005), nor does the fake harness unless scripted.
   */
  Schema.Struct({
    type: Schema.Literal("provider.failed"),
    requestId: Schema.String,
    provider: Schema.String,
    model: Schema.optionalKey(Schema.String),
    reason: ProviderFailure,
    until: Schema.String,
    reset: Schema.Boolean,
    error: Schema.String,
  }),
  /** The turn's first model request on `model` succeeded: a failure Verdandi recorded for it, or its provider, is over. */
  Schema.Struct({ type: Schema.Literal("provider.succeeded"), provider: Schema.String, model: Schema.String }),
  /** `limit`: the task's `maxCost` or `maxTurns` stopped the turn; `error` says which. */
  Schema.Struct({
    type: Schema.Literal("turn.finished"),
    status: Schema.Literals(["success", "error", "limit"]),
    error: Schema.optionalKey(Schema.String),
  }),
]);
export type HarnessEvent = typeof HarnessEvent.Type;

/** One parameter of a Verdandi tool, which the harness shows the agent in its own schema format. */
export type ToolParam = {
  readonly type: "string" | "number" | "boolean";
  readonly description: string;
  readonly optional?: boolean;
};

/**
 * One of Verdandi's own tools as a harness serves it (DESIGN §9.6): defined once in `packages/tools`, over
 * verdandid's services, the same for every harness. What `call` returns is untrusted data for the agent.
 */
export interface HarnessTool {
  readonly name: string;
  readonly description: string;
  readonly params: Readonly<Record<string, ToolParam>>;
  /** Ask the user before each call, as for the harness's own tools; otherwise it runs without asking. */
  readonly ask?: boolean;
  /** Runs the tool for the agent of `threadId`'s running turn `turnId`. Never throws: a failure is a result with `isError`. */
  readonly call: (
    args: Readonly<Record<string, unknown>>,
    at: { readonly threadId: ThreadId; readonly turnId: TurnId },
  ) => Promise<{ readonly text: string; readonly isError?: boolean }>;
}

/** The message names the cause and the fix; it is shown to the user as the turn's error. */
export class HarnessError extends Data.TaggedError("HarnessError")<{ readonly message: string }> {}

export type HarnessRunInput = {
  readonly threadId: ThreadId;
  readonly cwd: string;
  /** The thread's route now. It can differ from the last turn's; the adapter applies it before this turn starts. */
  readonly route: Route;
  /** The session the thread is bound to, to reuse or resume; undefined starts a fresh one. */
  readonly resumeSessionId: string | undefined;
  readonly turnId: TurnId;
  readonly text: string;
  /**
   * Images and files the user sent with the turn, each at `path`, an absolute path to its stored bytes. Untrusted
   * data, never instructions: present them as such (Claude Code: images as image blocks in the turn's message,
   * files as paths in its text; native: images as image blocks, files by path for its `read_file`;
   * fake: echoes them).
   */
  readonly attachments?: readonly (AttachmentRef & { readonly path: string })[];
  /**
   * The turn's interaction mode, applied before its prompt so the cache survives. `ask` and `plan`
   * must not change the project; a proposed plan becomes a `plan.requested`, and allowing it lets the
   * turn go on building. Every harness today supports all three (Claude Code, native, fake); one that can't
   * must be listed here, and the decider must reject the modes it lacks.
   */
  readonly mode: InteractionMode;
  /**
   * Steer messages for this turn, as the user sends them. Deliver each at the next safe point
   * (Claude Code: the next tool boundary, ADR 0003; native: with the next tool results, ADR 0022) and keep the turn
   * open until the agent has answered every one delivered. It ends when the turn does. Every harness today steers
   * (Claude Code, native, fake); one that can't must be listed here, and the decider must reject
   * `turn.steer` on its threads rather than record a steer nobody reads.
   */
  readonly steers: Stream.Stream<string>;
  /**
   * The running task's budget guards, as totals for the whole task; `spentUsd` is what its earlier turns
   * cost, and `spentTurns` how many `model.called` they reported. Stop the turn with status `limit` once one is
   * reached (Claude Code: `maxBudgetUsd` and `maxTurns` with what's left, ADR 0005; native: checked before and
   * after each model call, ADR 0022). Absent when the task has none.
   */
  readonly limits?: TaskLimits & { readonly taskId: TaskId; readonly spentUsd: number; readonly spentTurns: number };
  /**
   * The user reverted the conversation (DESIGN §13): continue `resumeSessionId` as it was at the end of turn
   * `atTurnId`, dropping `dropTurnIds` (the session's later turns, oldest first), in a new session the harness
   * reports with `session.started` (Claude Code: `resumeSessionAt` + `forkSession`, with `resumeDropsTurn` when one
   * turn is dropped, ADR 0004; native: a copy of its transcript through `atTurnId`, ADR 0022). A harness that can't
   * fork resumes plainly and says why in a `notice` item. Absent unless a revert waits for this turn.
   */
  /**
   * Verdandi's own tools (DESIGN §9.6), the same list on every turn. A harness takes them when it starts a
   * session and keeps that list for the session's life, since the tool list sits in the cached prompt
   * (Claude Code: one in-process MCP server in `mcpServers`, ADR 0005; native: in the session's `tools`, ADR 0022).
   * Absent when there are none.
   */
  readonly tools?: readonly HarnessTool[];
  /**
   * What Verdandi remembers (DESIGN §14.2), given on a new session's first turn only: put it at the head of the
   * turn's message, marked as data, so it stays fixed in the session's history (Claude Code and native: a text block
   * before the turn's own). Absent when there's nothing to remember, and on every later turn.
   */
  readonly memory?: string;
  /**
   * The summary of the thread so far, given on the first turn of a session that takes the thread over from another
   * harness (DESIGN §8.2 lever 5): fenced and marked as data, put right after `memory` at the head of the turn's message,
   * so it stays fixed in the session's history (Claude Code and native: a text block of its own; fake: records it).
   */
  readonly handoff?: string;
  /**
   * A one-line reminder to consider saving memory, on every Nth turn of a thread (DESIGN §14.2): put it after the
   * turn's own message, never in the system prompt (Claude Code and native: a text block after the turn's; fake:
   * records it).
   */
  readonly nudge?: string;
  readonly fork?: { readonly atTurnId: TurnId; readonly dropTurnIds: readonly TurnId[]; readonly transcriptPath?: string };
  /**
   * The turn's own effort, when auto effort (DESIGN §8.7) moved it off `route.effort`: apply it for this turn without
   * changing the cached prefix (native: a per-message effort before the turn's message, ADR 0022; fake: records it). Only
   * given to a harness that `inSessionEffort` lists; the next turn without one goes back to `route.effort`.
   */
  readonly effort?: Effort;
  /**
   * Scans untrusted text the harness puts in front of the agent itself (DESIGN §17), from `file` (a context file, or
   * a skill's SKILL.md for an index), and answers whether it's flagged; Verdandi records a hit on the turn, as
   * `withheld` text. The harness leaves flagged text out and says so (native: a context file or a skill's description
   * in a new session's prompt, with a `notice`). Absent when Verdandi doesn't scan, e.g. a background review.
   */
  readonly scan?: (file: string, text: string) => Promise<boolean>;
};

/**
 * Harnesses that change effort within a session without a cache miss, so auto effort moves a turn's effort on them
 * (DESIGN §8.7). Claude Code rewrites the conversation's cache on an effort change (ADR 0002), so its tasks keep theirs.
 */
export const inSessionEffort: Record<HarnessId, boolean> = { "claude-code": false, native: true, fake: true };

/**
 * Slice-1 subset of the harness contract (DESIGN §9.2): one `run` per turn. The adapter keeps its
 * live session per thread and resumes by id after a restart. Interrupting the fiber that runs the
 * stream interrupts the turn: the adapter stops the harness and leaves the session resumable. A
 * thread's next `run` starts only after the previous stream has finished, finalizers included.
 */
export interface HarnessAdapter {
  readonly id: HarnessId;
  /**
   * The context and skill files the harness loads into the agent's context by itself when it starts or resumes a
   * session in `cwd`, as absolute paths. Verdandi scans them before each turn and, when the scan flags one the user
   * hasn't trusted, holds the turn for the user, since the harness can't leave one out (DESIGN §17; Claude Code: its
   * CLAUDE.md files and imports, rules, skills, commands and agents, ADR 0020; fake: `CLAUDE.md` in `cwd`). Absent
   * for a harness that loads none (native: it reads its own through `scan`).
   */
  loads?(cwd: string): readonly string[];
  run(input: HarnessRunInput): Stream.Stream<HarnessEvent, HarnessError>;
  /** Answers a request the running turn raised. Unknown ids are ignored: their turn has ended. */
  respond(threadId: ThreadId, requestId: string, resolution: Resolution): Effect.Effect<void>;
  /**
   * Moves the running turn onto `route` for the rest of its steps: an approved plan's build (DESIGN §8.2
   * lever 3). Verdandi calls it just before `respond` allows the plan, and the agent's next step must run
   * on `route` (Claude Code: `setModel` lands before the approval is answered, ADR 0013; native: its next request,
   * ADR 0022). `route` keeps the turn's harness. Every harness today can (Claude Code, native, fake); one that can't
   * must be listed here, and
   * the decider must not reroute its threads. A thread with no running turn is ignored.
   */
  reroute(threadId: ThreadId, route: Route): Effect.Effect<void>;
  /**
   * Closes the session the harness keeps warm between a thread's turns (Claude Code: its CLI process), or every one
   * without `threadId`; the thread's next turn resumes it in a fresh one. Verdandi calls it when it's done with a
   * thread (a batch task) and when it stops, so no harness process outlives it.
   */
  close(threadId?: ThreadId): Effect.Effect<void>;
}
