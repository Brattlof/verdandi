import { Schema } from "effect";
import { TurnStatus } from "./events.ts";
import { ProjectId, ThreadId, TurnId } from "./ids.ts";
import { AccessMode, Item, UsageFields } from "./items.ts";
import { InteractionMode, Route } from "./route.ts";

// Persisted: like events, a published version is never edited. A change is a v2 plus an upgrade on read.

/** Where inference ran. It decides which terms apply to the data (DESIGN §14.8). */
export const Provider = Schema.Literals(["anthropic", "fake"]);
export type Provider = typeof Provider.Type;

/** One completed turn, normalized across harnesses and with secrets redacted (DESIGN §14.6). */
export const Trajectory = Schema.Struct({
  v: Schema.Literal(1),
  threadId: ThreadId,
  turnId: TurnId,
  projectId: ProjectId,
  text: Schema.String,
  mode: InteractionMode,
  /** The route the turn ran on. With `provenance`, it says which harness and model produced the data. */
  route: Route,
  provenance: Schema.Struct({
    provider: Provider,
    harnessVersion: Schema.optionalKey(Schema.String),
    /** `metered` if any of the turn's usage was paid for as metered; absent when the turn reported no usage. */
    accessMode: Schema.optionalKey(AccessMode),
  }),
  /** Points at the harness's own transcript, which stays where the harness keeps it. */
  transcript: Schema.optionalKey(Schema.Struct({ sessionId: Schema.String, path: Schema.optionalKey(Schema.String) })),
  /** The main agent's steps and its subagents' (those carry `parentToolUseId`), in order. */
  items: Schema.Array(Item),
  usage: Schema.Array(Schema.Struct(UsageFields)),
  outcome: Schema.Struct({ status: TurnStatus, error: Schema.optionalKey(Schema.String) }),
  startedAt: Schema.String,
  completedAt: Schema.String,
});
export type Trajectory = typeof Trajectory.Type;
