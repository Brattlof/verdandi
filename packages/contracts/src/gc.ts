import { Schema } from "effect";
import { ThreadId } from "./ids.ts";

/** What a cleanup sweep removed (ADR 0021), or with `dryRun` what it would remove. */
export const GcReport = Schema.Struct({
  dryRun: Schema.Boolean,
  /** The checkpoint and revert refs this profile's threads had before the sweep. */
  refs: Schema.Int,
  /** The refs it removed, by thread. */
  removed: Schema.Array(Schema.Struct({ threadId: ThreadId, refs: Schema.Array(Schema.String) })),
  /**
   * Worktrees of threads archived longer than the policy keeps them: each removed (queued on its thread, like
   * Remove worktree), or `kept` with the reason.
   */
  worktrees: Schema.Array(Schema.Struct({ threadId: ThreadId, root: Schema.String, kept: Schema.optionalKey(Schema.String) })),
});
export type GcReport = typeof GcReport.Type;

/** Why the cleanup policy can't run. The message names the file, the key and the fix. */
export class GcUnavailable extends Schema.TaggedError<GcUnavailable>()("GcUnavailable", {
  reason: Schema.Literals(["InvalidGcPolicy"]),
  message: Schema.String,
}) {}
