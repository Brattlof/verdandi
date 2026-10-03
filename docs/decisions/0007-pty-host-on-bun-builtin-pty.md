# 0007 · The PTY host uses Bun's built-in PTY

## Status

Accepted for Windows (M0 spike 007, 2026-09-29). macOS verified by the terminal tests in `apps/agent/src/rpc/server.test.ts` (2026-10-01): open, output, reattach, close with no shell left, and a host crash. Linux is unverified.

## Context

DESIGN §13 puts terminals in a separate PTY host process supervised by verdandid, and §19 named `bun-pty` for it. Windows is first-class, so ConPTY had to handle resize, heavy output, Ctrl+C and killing process trees. Bun 1.3 added a built-in PTY (`Bun.spawn(argv, { terminal })`, `Bun.Terminal`).

Spike 007 compared the built-in PTY with `bun-pty@0.4.10` on Windows 11 with PowerShell 5.1 and cmd.

## Decision

1. The PTY host uses Bun's built-in PTY. No PTY dependency.
2. At startup the host calls `SetConsoleCtrlHandler(NULL, FALSE)` through `bun:ffi`, so shells never inherit a disabled Ctrl+C.
3. Killing a terminal runs `taskkill /PID <shell pid> /T /F` on the PID the host captured at spawn, before the shell exits, then disposes the PTY. Nothing is ever killed by name or pattern.
4. The host coalesces PTY output per ~16 ms frame before sending it to clients.
5. Arguments are passed as separate `argv` entries, never pre-quoted.

## Consequences

- Resize, 200k lines of output, Ctrl+C (~30 ms) and tree kill all work on Windows with these fixes. Both PTYs behaved the same on Ctrl+C and throughput; the built-in one avoids a prebuilt native binary in the supply chain.
- Without fix 2, Ctrl+C silently does nothing whenever verdandid is launched from a process group that ignores it. A test launches the host that way.
- ConPTY caps bulk output at roughly 0.6 MB/s; a command that prints megabytes will be slow in a terminal whatever we do. Anything that only needs a command's output, not an interactive terminal, should use a pipe (20× faster here).
- `taskkill /T` misses children whose parent already exited. If that matters in practice, the upgrade is a Job Object with kill-on-close via `bun:ffi`.
- Linux needs a CI run of the terminal tests.
