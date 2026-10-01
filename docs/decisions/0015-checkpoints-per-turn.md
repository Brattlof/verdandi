# 0015 · Checkpoints at the start and end of each turn

## Status

Accepted (issue #74, 2026-10-01). Supersedes ADR 0010.

## Context

ADR 0010 diffed the working tree against `HEAD`, so a turn's diff showed the user's own uncommitted edits and everything earlier turns did, and nothing recorded how the files were before a turn. DESIGN §13 plans checkpoints in hidden refs, saved through a temporary index; revert (ADR 0004) restores files from them.

## Decision

1. The reactor saves the tree of the thread's folder when each turn starts and again when it ends, after the harness has stopped (an interrupted turn included), as `refs/verdandi/checkpoints/<thread>/<turn>/start` and `…/end`. Ids are %-escaped outside `[A-Za-z0-9_-]`, so any id makes a valid ref of its own. A checkpoint is a parentless commit with a fixed `Verdandi` identity.
2. The tree is built in a temporary index (`GIT_INDEX_FILE`), copied from the user's so its stat cache spares hashing unchanged files, then `git add --all` and `write-tree`. The user's branch, index and stash are never touched. Untracked files are included, ignored ones not, and the whole repo is saved even when the project is a subfolder of it.
3. `DiffGet` with a `turnId` diffs that turn's start checkpoint against its end (a running turn's end is the working tree now). Without one, it diffs the thread's first checkpoint against the working tree, snapshotted the same way. A thread from before checkpoints falls back to `HEAD`; a turn from before them fails with `NoCheckpoint`.
4. Checkpoints are refs, not events: git is their store, and the ref name says which turn each belongs to. A failed checkpoint is logged and never fails the turn.
5. A folder outside git has no checkpoints, and its diffs fail with `NotAGitRepo` as before. The payload limits of ADR 0010 stay.
6. Refs of archived threads are kept. Pruning them is a later cleanup policy.

## Consequences

- A turn's diff is exactly what changed during it, whoever changed it: an edit the user makes while the turn runs shows in it, one made between turns doesn't.
- Changes made through a shell or codegen show in the turn that made them, which ADR 0010 couldn't do.
- Each turn costs two snapshots: a handful of git processes and hashing whatever changed. A huge untracked, unignored folder is hashed each time.
- `DiffGet` without a turn writes loose objects for its snapshot (as `git stash create` would), never a ref or the index.
- Checkpoint refs live in the repo's shared ref store, so worktrees of one repo see each other's checkpoints, and `git gc` keeps their objects.
