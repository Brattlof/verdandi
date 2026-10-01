import type { ThreadId } from "@verdandi/contracts";

/**
 * One part of a ref name for any id: bytes outside `[A-Za-z0-9_-]` are %-escaped, so no id can make an
 * invalid ref (`..`, spaces, `.lock`) or another id's. Pure, so the decider can name branches.
 */
export const refPart = (id: string) =>
  Array.from(Buffer.from(id, "utf8"), (b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9_-]/.test(c) ? c : `%${b.toString(16).padStart(2, "0")}`;
  }).join("");

/** The branch a thread's worktree is on. */
export const worktreeBranch = (threadId: ThreadId) => `verdandi/${refPart(threadId)}`;
