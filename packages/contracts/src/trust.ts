import { Schema } from "effect";
import { ProjectId, ThreadId } from "./ids.ts";

/**
 * What a trusted list is for: `verifiers` from `escalation.verifiers` in `.verdandi/routing.yaml` and `setup` from
 * `.verdandi/worktree.yaml`, which verdandid runs only once the user trusts that exact list for the project; `mcp`, the
 * MCP servers the project's own files configure (`.verdandi/mcp.yaml`, and `.mcp.json` when the home imports Claude
 * Code's), which the native harness starts only once the user trusts that exact list (`mcpEntry`); `context`, context
 * and skill files a harness loads by itself that the injection scan flagged (`contextEntry`), which it starts with only
 * once the user trusts those exact files' contents for the project (DESIGN §17).
 */
export const TrustPurpose = Schema.Literals(["verifiers", "setup", "context", "mcp"]);
export type TrustPurpose = typeof TrustPurpose.Type;

/** The project file each command purpose's commands come from, relative to the project. */
export const trustFiles = {
  verifiers: ".verdandi/routing.yaml",
  setup: ".verdandi/worktree.yaml",
  mcp: ".verdandi/mcp.yaml and .mcp.json",
} as const;

/** What a trusted list of each purpose holds, for the user. */
export const trustSubjects: Record<TrustPurpose, string> = {
  verifiers: `the project's verifiers from ${trustFiles.verifiers}`,
  setup: `the project's worktree setup from ${trustFiles.setup}`,
  context: "context files the injection scan flagged",
  mcp: `the project's MCP servers from ${trustFiles.mcp}`,
};

/**
 * A flagged context file as a `context` list names it: its path, and the start of its contents' SHA-256, so trusting
 * it covers those contents only and a changed file asks again.
 */
export const contextEntry = (path: string, sha256: string) => `${path} (sha256 ${sha256.slice(0, 16)})`;

/** A list the user trusted in a project. `threadId` is the thread it was trusted in, which revoking it names. */
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
