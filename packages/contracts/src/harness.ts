import { Data, Schema, type Stream } from "effect";
import type { ThreadId, TurnId } from "./ids.ts";
import { Item, UsageFields } from "./items.ts";
import type { HarnessId, Route } from "./route.ts";

/** What every harness adapter reports, normalized. */
export const HarnessEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session.started"), sessionId: Schema.String, harnessVersion: Schema.String }),
  Schema.Struct({ type: Schema.Literal("text.delta"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("item"), item: Item }),
  Schema.Struct({ type: Schema.Literal("usage"), ...UsageFields }),
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
  readonly route: Route;
  /** The thread's stored harness session, when resuming after a restart. */
  readonly resumeSessionId: string | undefined;
  readonly turnId: TurnId;
  readonly text: string;
};

/**
 * Slice-1 subset of the harness contract (DESIGN §9.2): one `run` per turn. The adapter keeps its
 * live session per thread and resumes by id after a restart. Steer, interrupt and respond come later.
 */
export interface HarnessAdapter {
  readonly id: HarnessId;
  run(input: HarnessRunInput): Stream.Stream<HarnessEvent, HarnessError>;
}
