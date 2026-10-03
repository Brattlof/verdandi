# 0027 · The terminal UI runs on OpenTUI

## Status

Accepted (2026-10-03). Settles DESIGN §23 question 8's library.

## Context

The terminal chat is Verdandi's default surface (DESIGN §11), but it was a line loop over `console`: no screen of its own, no composer while the agent streams, and requests answered between streamed lines. The two serious choices were Ink (React for the terminal, pure JavaScript; ~9M weekly npm downloads, used by Claude Code, and by Hermes through its own fork) and OpenTUI (TypeScript over a native Zig renderer reached through `bun:ffi`; ~1.1M weekly, made by and used in opencode). The owner chose OpenTUI: it is built for Bun, draws only the cells that changed, and opencode proves it at scale.

A spike on Windows (Bun 1.4.2, OpenTUI 0.5.11) checked it before adoption: the native renderer loads; headless, 2,000 lines of Unicode and CJK render in 107 ms and an idle frame takes about 0.4 ms; in a real ConPTY it streams, takes typed input, and Ctrl+C exits cleanly. After typing and Enter it sent 538 bytes, since it only redraws what changed.

## Decision

1. **OpenTUI, through `@opentui/react`,** pinned exactly (0.5.11 at adoption: the newest at least 14 days old). The TUI is React, like `packages/ui`.
2. **One session, two terminal surfaces.** `src/cli/chat-session.ts` holds everything the chat does: the thread feed and the lines it writes, slash commands, answering requests, steering, Ctrl+C. It writes through an `Io` (`write`, `prompt`, and `suspend`, which hands the terminal to `$EDITOR` for a plan edit). `src/tui/tui.tsx` draws it: the transcript, a line saying what a typed line will do (answer the request, steer the running turn, or send), and the composer. The line chat (`--plain`) prints it. So the two can't drift apart.
3. **Bare `verdandi` opens the TUI in a terminal.** `--plain`, or stdin or stdout that isn't a terminal (a pipe, a script), gets the line chat. The TUI module is imported only then, so headless commands never load the native renderer.
4. **Performance:** the transcript is an external store that React reads at most once per ~16 ms frame, so a burst of text deltas renders once. Lines keep a stable key for life, and it holds the last 2,000 lines. There's no spinner: the status line says "working" and stays still.

## Consequences

- OpenTUI is the first dependency that ships a native binary (one prebuilt package per platform, loaded through `bun:ffi`), against DESIGN §19's "no native addon" default. It's accepted for the TUI only, and it's loaded only when the TUI opens.
- OpenTUI is pre-1.0 and releases every few days, so updates are frequent and the API may move; the 14-day rule still applies to every update.
- `bun build --compile` must embed the native renderer for releases; opencode ships this way, but Verdandi's release build doesn't exist yet, and this needs checking when it does.
- Tests render the real `Chat` with OpenTUI's headless test renderer against verdandid on the fake harness, and wait on the transcript's change notices, never on timers.
- The TUI starts as the line chat's equal. Multiline editing, completion, and showing tool calls and diffs in panes come next.
