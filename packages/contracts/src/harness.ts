import { Data, type Effect, Schema, type Stream } from "effect";
import type { AttachmentRef } from "./attachments.ts";
import type { TaskId, ThreadId, TurnId } from "./ids.ts";
import { Item, Quota, UsageFields } from "./items.ts";
import { Question, type Resolution } from "./requests.ts";
import type { HarnessId, InteractionMode, Route } from "./route.ts";
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
  /** `limit`: the task's `maxCost` or `maxTurns` stopped the turn; `error` says which. */
  Schema.Struct({
    type: Schema.Literal("turn.finished"),
    status: Schema.Literals(["success", "error", "limit"]),
    error: Schema.optionalKey(Schema.String),
  }),
]);
export type HarnessEvent = typeof HarnessEvent.Type;

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
   * files as paths in its text; fake: echoes them). The native harness isn't built; it takes them the same way.
   */
  readonly attachments?: readonly (AttachmentRef & { readonly path: string })[];
  /**
   * The turn's interaction mode, applied before its prompt so the cache survives. `ask` and `plan`
   * must not change the project; a proposed plan becomes a `plan.requested`, and allowing it lets the
   * turn go on building. Every harness today supports all three (Claude Code, fake); one that can't
   * must be listed here, and the decider must reject the modes it lacks.
   */
  readonly mode: InteractionMode;
  /**
   * Steer messages for this turn, as the user sends them. Deliver each at the next safe point
   * (Claude Code: the next tool boundary, ADR 0003) and keep the turn open until the agent has
   * answered every one delivered. It ends when the turn does. Every harness today steers
   * (Claude Code, fake); one that can't must be listed here, and the decider must reject
   * `turn.steer` on its threads rather than record a steer nobody reads.
   */
  readonly steers: Stream.Stream<string>;
  /**
   * The running task's budget guards, as totals for the whole task; `spentUsd` is what its earlier turns
   * cost. Stop the turn with status `limit` once one is reached (Claude Code: `maxBudgetUsd` and
   * `maxTurns`, ADR 0005). Absent when the task has none.
   */
  readonly limits?: TaskLimits & { readonly taskId: TaskId; readonly spentUsd: number };
  /**
   * The user reverted the conversation (DESIGN §13): continue `resumeSessionId` as it was at the end of turn
   * `atTurnId`, dropping `dropTurnIds` (the session's later turns, oldest first), in a new session the harness
   * reports with `session.started` (Claude Code: `resumeSessionAt` + `forkSession`, with `resumeDropsTurn` when one
   * turn is dropped, ADR 0004). A harness that can't fork resumes plainly and says why in a `notice` item. Absent
   * unless a revert waits for this turn.
   */
  readonly fork?: { readonly atTurnId: TurnId; readonly dropTurnIds: readonly TurnId[]; readonly transcriptPath?: string };
};

/**
 * Slice-1 subset of the harness contract (DESIGN §9.2): one `run` per turn. The adapter keeps its
 * live session per thread and resumes by id after a restart. Interrupting the fiber that runs the
 * stream interrupts the turn: the adapter stops the harness and leaves the session resumable. A
 * thread's next `run` starts only after the previous stream has finished, finalizers included.
 */
export interface HarnessAdapter {
  readonly id: HarnessId;
  run(input: HarnessRunInput): Stream.Stream<HarnessEvent, HarnessError>;
  /** Answers a request the running turn raised. Unknown ids are ignored: their turn has ended. */
  respond(threadId: ThreadId, requestId: string, resolution: Resolution): Effect.Effect<void>;
  /**
   * Moves the running turn onto `route` for the rest of its steps: an approved plan's build (DESIGN §8.2
   * lever 3). Verdandi calls it just before `respond` allows the plan, and the agent's next step must run
   * on `route` (Claude Code: `setModel` lands before the approval is answered, ADR 0013). `route` keeps the
   * turn's harness. Every harness today can (Claude Code, fake); one that can't must be listed here, and
   * the decider must not reroute its threads. A thread with no running turn is ignored.
   */
  reroute(threadId: ThreadId, route: Route): Effect.Effect<void>;
}
