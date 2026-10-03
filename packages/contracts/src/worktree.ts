import { Schema } from "effect";
import type { Event } from "./events.ts";
import { VerifierRun } from "./items.ts";

/**
 * A thread's git worktree (DESIGN §13). `creating` until the reactor has added it; `failed` when adding it
 * failed (`error` says why); `removing` until it's gone, then `removed`. The branch outlives the worktree.
 */
export const WorktreeState = Schema.Literals(["creating", "ready", "failed", "removing", "removed"]);
export type WorktreeState = typeof WorktreeState.Type;

export const WorktreeView = Schema.Struct({
  branch: Schema.String,
  state: WorktreeState,
  /** The worktree's folder, which `git worktree remove` takes. Absent until it's first created. */
  root: Schema.optionalKey(Schema.String),
  /** The project's folder inside the worktree, where the harness, checkpoints and diffs run. Absent until it's first created. */
  path: Schema.optionalKey(Schema.String),
  /** The project's setup command, as it ran when the worktree was last created. Absent when the project has none. */
  setup: Schema.optionalKey(VerifierRun),
  /** The setup command waiting for the user to trust it, which the thread's next turn asks about. */
  held: Schema.optionalKey(Schema.String),
  /** Why adding or removing it last failed; cleared by the next try. */
  error: Schema.optionalKey(Schema.String),
});
export type WorktreeView = typeof WorktreeView.Type;

/** What the reactor reports about a thread's worktree. */
export const WorktreeReport = Schema.Union([
  Schema.Struct({ type: Schema.Literal("created"), root: Schema.String, path: Schema.String }),
  Schema.Struct({ type: Schema.Literal("failed"), action: Schema.Literals(["create", "remove"]), error: Schema.String }),
  Schema.Struct({ type: Schema.Literal("setup"), run: VerifierRun }),
  Schema.Struct({ type: Schema.Literal("setup.held"), command: Schema.String }),
  Schema.Struct({ type: Schema.Literal("removed") }),
]);
export type WorktreeReport = typeof WorktreeReport.Type;

type WorktreeEvent = Extract<Event, { type: `thread.worktree.${string}` }>;

/** The thread's worktree after `e`: the server's projector and the web UI both fold events with it. */
export const nextWorktree = (current: WorktreeView | null, e: WorktreeEvent): WorktreeView | null => {
  const { error: _, ...kept } = current ?? { branch: "", state: "creating" as const };
  switch (e.type) {
    case "thread.worktree.requested": {
      const { setup: _s, held: _h, ...rest } = kept;
      return { ...rest, branch: e.branch, state: "creating" };
    }
    case "thread.worktree.created":
      return { ...kept, state: "ready", root: e.root, path: e.path };
    case "thread.worktree.failed":
      return { ...kept, state: e.action === "create" ? "failed" : "ready", error: e.error };
    case "thread.worktree.setup.ran": {
      const { type: _t, v: _v, threadId: _i, ...run } = e;
      if (!current) return current;
      const { held: _h, ...rest } = current;
      return { ...rest, setup: run };
    }
    case "thread.worktree.setup.held":
      return current && { ...current, held: e.command };
    case "thread.worktree.removal.requested":
      return { ...kept, state: "removing" };
    case "thread.worktree.removed":
      return { ...kept, state: "removed" };
  }
};
