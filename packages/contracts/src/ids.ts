import { Schema } from "effect";

export const ProjectId = Schema.String.pipe(Schema.brand("ProjectId"));
export type ProjectId = typeof ProjectId.Type;

export const ThreadId = Schema.String.pipe(Schema.brand("ThreadId"));
export type ThreadId = typeof ThreadId.Type;

/**
 * The stream of events about the profile rather than one thread, such as skill pins: what they record has no thread.
 * Never a thread's id, which are UUIDs.
 */
export const profileStream = "profile" as ThreadId;

/**
 * The profile's Skills hub thread, in its workspace (DESIGN §13, §14.4): where install and update requests wait, since a
 * CLI install has no thread of its own. Created by the first install. Never a UUID, so never a user's thread.
 */
export const hubThread = "skills-hub" as ThreadId;

/** Also sent to Claude Code as the prompt's `uuid`, so a turn can be forked at later (ADR 0004). */
export const TurnId = Schema.String.pipe(Schema.brand("TurnId"));
export type TurnId = typeof TurnId.Type;

/** Client-generated; retrying a command with the same id returns the same receipt. */
export const CommandId = Schema.String.pipe(Schema.brand("CommandId"));
export type CommandId = typeof CommandId.Type;

/** A task's id is the id of the turn that started it, so the decider can name it without generating one. */
export const TaskId = Schema.String.pipe(Schema.brand("TaskId"));
export type TaskId = typeof TaskId.Type;
