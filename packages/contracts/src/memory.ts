import { Schema } from "effect";
import { ThreadId, TurnId } from "./ids.ts";

/** Memory's two stores (DESIGN §14.2): about the user, across projects, and about one project. */
export const MemoryScope = Schema.Literals(["user", "project"]);
export type MemoryScope = typeof MemoryScope.Type;

/** Each store's size in characters. Memory is capped on purpose: a save past it fails and asks for consolidation. */
export const memoryCaps: Readonly<Record<MemoryScope, number>> = { user: 1500, project: 2000 };

/**
 * One remembered fact. `source` is where it was saved: a thread and, when the agent saved it, its turn.
 * `confirmedAt` moves when it is saved again or edited. Untrusted data, like everything an agent wrote.
 */
export const MemoryEntry = Schema.Struct({
  entryId: Schema.String,
  scope: MemoryScope,
  text: Schema.String,
  source: Schema.Struct({ threadId: ThreadId, turnId: Schema.optionalKey(TurnId) }),
  savedAt: Schema.String,
  confirmedAt: Schema.String,
});
export type MemoryEntry = typeof MemoryEntry.Type;

/** What Verdandi remembers for a thread: about its user and its project, most recently confirmed first. */
export const MemoryView = Schema.Struct({
  projectPath: Schema.String,
  user: Schema.Array(MemoryEntry),
  project: Schema.Array(MemoryEntry),
});
export type MemoryView = typeof MemoryView.Type;
