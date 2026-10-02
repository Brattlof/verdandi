import { Schema } from "effect";
import { ThreadId } from "./ids.ts";

/** A shell in a PTY on verdandid's PTY host (ADR 0007). Terminals are process state, never events: they don't outlive verdandid. */
export const TerminalId = Schema.String.pipe(Schema.brand("TerminalId"));
export type TerminalId = typeof TerminalId.Type;

/** A terminal's size in character cells. */
export const TerminalSize = {
  cols: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  rows: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
};

/**
 * `running` until the shell exits (`exitCode` is its code, or null when a signal ended it) or the PTY host
 * stopped under it (`lost`). An ended terminal stays listed, output and all, until it is closed.
 */
export const TerminalStatus = Schema.Literals(["running", "exited", "lost"]);
export type TerminalStatus = typeof TerminalStatus.Type;

export const TerminalView = Schema.Struct({
  terminalId: TerminalId,
  threadId: ThreadId,
  /** The folder the shell started in. */
  cwd: Schema.String,
  /** The shell's process id, as captured at spawn. */
  pid: Schema.Int,
  status: TerminalStatus,
  exitCode: Schema.NullOr(Schema.Int),
});
export type TerminalView = typeof TerminalView.Type;

/**
 * A terminal's output as UTF-8 text with its escape sequences, for a terminal emulator to render.
 * The snapshot replays the output kept for reattaching (the last ~256 KiB); live output follows, a message per ~16 ms
 * frame or, for a client that reads slower than that, all that has come since it last read.
 */
export const TerminalFeed = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snapshot"), terminal: TerminalView, output: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("output"),
    data: Schema.String,
    /** Characters of output skipped just before `data`, because this client read too slowly to keep up; the client shows a marker. */
    skipped: Schema.optionalKey(Schema.Int),
  }),
  /** The shell exited, or was lost with the PTY host. */
  Schema.Struct({ kind: Schema.Literal("ended"), terminal: TerminalView }),
]);
export type TerminalFeed = typeof TerminalFeed.Type;

/** Why a terminal can't be opened or used. The message names the cause and the fix. */
export class TerminalUnavailable extends Schema.TaggedError<TerminalUnavailable>()("TerminalUnavailable", {
  reason: Schema.Literals(["ThreadNotFound", "TerminalNotFound", "SpawnFailed"]),
  message: Schema.String,
}) {}
