import { Schema } from "effect";
import { ProjectId, ThreadId } from "./ids.ts";

/**
 * What a project's own commands are for: `verifiers` from `escalation.verifiers` in `.verdandi/routing.yaml`, `setup`
 * from `.verdandi/worktree.yaml`. verdandid runs neither until the user trusts that exact list for the project.
 */
export const TrustPurpose = Schema.Literals(["verifiers", "setup"]);
export type TrustPurpose = typeof TrustPurpose.Type;

/** The project file each purpose's commands come from, relative to the project. */
export const trustFiles: Record<TrustPurpose, string> = { verifiers: ".verdandi/routing.yaml", setup: ".verdandi/worktree.yaml" };

/** A command list the user trusted in a project. `threadId` is the thread it was trusted in, which revoking it names. */
export const TrustedCommands = Schema.Struct({
  projectId: ProjectId,
  projectPath: Schema.String,
  hash: Schema.String,
  purpose: TrustPurpose,
  commands: Schema.Array(Schema.String),
  threadId: ThreadId,
  /** ISO timestamp. */
  trustedAt: Schema.String,
});
export type TrustedCommands = typeof TrustedCommands.Type;
