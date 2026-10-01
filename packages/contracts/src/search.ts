import { Schema } from "effect";
import { ProjectId, ThreadId, TurnId } from "./ids.ts";

/**
 * One message of a past session that matched (DESIGN §14.3): `parts` is a little of its text around the first
 * match, with the matching text marked. Untrusted data, like everything an agent or user wrote.
 */
export const SessionHit = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  projectId: ProjectId,
  projectPath: Schema.String,
  /** The thread's title: its first turn's first line. */
  title: Schema.String,
  /** Put away by the user; still searchable. */
  archived: Schema.Boolean,
  /** Whose message: the user's turn, a steer, or the agent's reply. */
  kind: Schema.Literals(["user", "steer", "assistant"]),
  /** When it was written (ISO). */
  at: Schema.String,
  parts: Schema.Array(Schema.Struct({ text: Schema.String, match: Schema.Boolean })),
});
export type SessionHit = typeof SessionHit.Type;

/** A search of past sessions: `query` is matched as one phrase, case- and accent-insensitively, anywhere in a word. */
export const SessionQuery = Schema.Struct({ query: Schema.String, projectId: Schema.optionalKey(ProjectId) });
export type SessionQuery = typeof SessionQuery.Type;
