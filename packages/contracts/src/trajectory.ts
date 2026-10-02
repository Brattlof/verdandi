import { Schema } from "effect";
import { TurnStatus } from "./events.ts";
import { ProjectId, TaskId, ThreadId, TurnId } from "./ids.ts";
import { AccessMode, Item, UsageFields } from "./items.ts";
import { InteractionMode, Route } from "./route.ts";
import { RouteDecision, RouteInputs } from "./routing.ts";
import { TaskOutcome } from "./task.ts";

// Persisted: like events, a published version is never edited. A change is a v2 plus an upgrade on read.

/** Where inference ran. It decides which terms apply to the data (DESIGN §14.8). */
export const Provider = Schema.Literals(["anthropic", "fake"]);
export type Provider = typeof Provider.Type;

/** One completed turn, normalized across harnesses and with secrets redacted (DESIGN §14.6). */
export const Trajectory = Schema.Struct({
  v: Schema.Literal(1),
  threadId: ThreadId,
  turnId: TurnId,
  /** The task the turn belongs to, which its `TaskOutcome` shares. Absent on turns from before tasks existed. */
  taskId: Schema.optionalKey(TaskId),
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

// Exports (DESIGN §14.6): files for the lab, never read back. A change is a v2 the lab can tell apart.

const ToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  /** `arguments` is the tool's input as a JSON string. */
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
});

/** A chat message in OpenAI's format, with tool calls and their results. */
export const ChatMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("user"), content: Schema.String }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.NullOr(Schema.String),
    tool_calls: Schema.optionalKey(Schema.Array(ToolCall)),
  }),
  Schema.Struct({ role: Schema.Literal("tool"), tool_call_id: Schema.String, content: Schema.String }),
]);
export type ChatMessage = typeof ChatMessage.Type;

/**
 * One line of `verdandi trajectories export --format jsonl`: a task's turns as the main agent's conversation.
 * Subagents' steps are left out; the tool call that started one has its result. Secrets are masked.
 */
export const MessageExample = Schema.Struct({
  messages: Schema.Array(ChatMessage),
  metadata: Schema.Struct({
    v: Schema.Literal(1),
    /** Absent for a turn from before tasks existed, which is a line of its own. */
    taskId: Schema.optionalKey(TaskId),
    threadId: ThreadId,
    projectId: ProjectId,
    /** The route of the task's first turn, and how its last turn ended. */
    route: Route,
    status: TurnStatus,
  }),
});
export type MessageExample = typeof MessageExample.Type;

/**
 * One line of `verdandi trajectories export --format routing`: what the router knew when a task started, the
 * route it ran on, and how it went (DESIGN §8.8). `text` is the task's first message, secrets masked.
 * `decision` and `inputs` are null for tasks recorded before they were kept.
 */
export const RoutingExample = Schema.Struct({
  v: Schema.Literal(1),
  taskId: TaskId,
  threadId: ThreadId,
  projectId: ProjectId,
  startedAt: Schema.String,
  text: Schema.String,
  mode: InteractionMode,
  /** How many images the task's first message had attached. */
  images: Schema.Number,
  route: Route,
  decision: Schema.NullOr(RouteDecision),
  inputs: Schema.NullOr(RouteInputs),
  outcome: TaskOutcome,
  /** Every turn's cost, metered and subscription alike. */
  costUsd: Schema.Number,
});
export type RoutingExample = typeof RoutingExample.Type;
