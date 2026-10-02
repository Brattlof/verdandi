# 0010 · M1 diffs are the working tree against HEAD

## Status

Superseded by ADR 0015 (checkpoints, 2026-10-01). Accepted (issue #14, 2026-09-30).

## Context

M1 includes diffs (DESIGN §21), but checkpoints, the hidden per-turn refs that would say exactly what each turn changed (§13), are M3. M1 needs a smaller way to show what a turn changed on disk that doesn't close off that design.

## Decision

1. `DiffGet` (`diff.*` in DESIGN §11) returns the thread's project working tree against `HEAD`, one unified diff per file, with new untracked files included and ignored ones left out. Paths are relative to the project folder, and only that folder is diffed.
2. With a `turnId`, it narrows to the files that turn's file tools touched, taken from its `tool.call` items (Claude Code: `Edit`, `MultiEdit`, `Write`, `NotebookEdit`). A harness with other tool names adds them to `apps/server/src/diffs/diff.ts`.
3. git runs read-only: `--no-optional-locks`, so the user's index is never refreshed; literal pathspecs; fixed `a/` `b/` prefixes; no external diff drivers. Nothing is stored, so there's no event or migration to undo when checkpoints replace this.
4. Payloads stay small: each file's diff is cut at 64 KiB on a line break and marked `truncated`, and once the response reaches 512 KiB the remaining files are counted in `omittedFiles`.
5. A project that isn't a git repo, doesn't exist or has no commits fails with `DiffUnavailable` and a message that names the fix.

## Consequences

- The diff can't separate the user's edits from the agent's. A file both touched shows both, and so does a file two turns edited.
- Changes the agent made through a shell (`Bash`, codegen, `git mv`) show in the thread's diff, not in a turn's.
- Work that was committed since the turn no longer shows, and files the agent wrote to ignored or out-of-project paths never do.
- Checkpoints (M3) change the base from `HEAD` to the turn's start and end snapshots. The `DiffGet` contract stays the same.
