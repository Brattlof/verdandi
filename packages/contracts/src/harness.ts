import { Data, type Effect, Schema, type Stream } from "effect";
import type { ThreadId, TurnId } from "./ids.ts";
import { Item, UsageFields } from "./items.ts";
import { Question, type Resolution } from "./requests.ts";
import type { HarnessId, Route } from "./route.ts";

/** What every harness adapter reports, normalized. */
export const HarnessEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session.started"), sessionId: Schema.String, harnessVersion: Schema.String }),
  Schema.Struct({ type: Schema.Literal("text.delta"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("item"), item: Item }),
  Schema.Struct({ type: Schema.Literal("usage"), ...UsageFields }),
  /** The harness blocks until `respond` answers `requestId`. */
  Schema.Struct({ type: Schema.Literal("approval.requested"), requestId: Schema.String, toolName: Schema.String, input: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("user-input.requested"), requestId: Schema.String, questions: Schema.Array(Question) }),
  Schema.Struct({
    type: Schema.Literal("turn.finished"),
    status: Schema.Literals(["success", "error"]),
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
   * Steer messages for this turn, as the user sends them. Deliver each at the next safe point
   * (Claude Code: the next tool boundary, ADR 0003) and keep the turn open until the agent has
   * answered every one delivered. It ends when the turn does. Every harness today steers
   * (Claude Code, fake); one that can't must be listed here, and the decider must reject
   * `turn.steer` on its threads rather than record a steer nobody reads.
   */
  readonly steers: Stream.Stream<string>;
};

/**
 * Slice-1 subset of the harness contract (DESIGN §9.2): one `run` per turn. The adapter keeps its
 * live session per thread and resumes by id after a restart. Interrupt comes later.
 */
export interface HarnessAdapter {
  readonly id: HarnessId;
  run(input: HarnessRunInput): Stream.Stream<HarnessEvent, HarnessError>;
  /** Answers a request the running turn raised. Unknown ids are ignored: their turn has ended. */
  respond(threadId: ThreadId, requestId: string, resolution: Resolution): Effect.Effect<void>;
}
