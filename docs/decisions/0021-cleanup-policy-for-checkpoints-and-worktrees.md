# 0021 · A cleanup policy for checkpoints and worktrees

## Status

Accepted (issue #128, 2026-10-02).

## Context

Every turn writes two checkpoint refs (ADR 0015), every revert with files one more, and a worktree git kept when its thread was archived stays on disk. Nothing removed them, so a busy repo's object store and the user's disk grew without bound. Refs live in the repo, which other profiles' threads (and their checkpoints) may share.

## Decision

1. The policy lives in the home's `gc.yaml`: `keepDays` (default 30) and `keepTurns` (default 10). It is read on each sweep; a broken file stops the sweep, naming the file and key.
2. verdandid sweeps when it starts and once a day; `verdandi gc` sweeps now through the running verdandid (the `Gc` RPC), and `--dry-run` only reports. `verdandi doctor` plans a sweep read-only and shows the refs, the worktrees' size and what the next sweep removes.
3. A turn's start and end checkpoints go together once the newer is older than `keepDays`; a revert ref goes by its own age. A thread that isn't archived always keeps its last `keepTurns` turns' checkpoints, its first start checkpoint (its whole diff starts there) and the ref its undoable revert restores.
4. Only refs under `refs/verdandi/checkpoints/` and `refs/verdandi/reverts/` whose thread is in this profile's database are considered, and none of a thread with a running turn. Each is deleted with `git update-ref --stdin` only if it still points where it did when planned.
5. Refs stay git's (ADR 0015), but each thread's removed refs are recorded as `thread.checkpoints.removed`, so the log says why a diff or revert no longer has its checkpoint.
6. A thread archived longer than `keepDays` whose worktree git kept gets `thread.worktree.remove` without force, through the usual reactor path. One with uncommitted changes or untracked files (`git status --porcelain`) is reported as kept with the reason, and records nothing, so a dirty worktree doesn't add events every day.

## Consequences

- Deleted refs make their objects unreachable; git's own `gc` reclaims the space later. Verdandi doesn't run `git gc` in the user's repo.
- Diffs of pruned turns and reverts to them fail with `NoCheckpoint`, naming the policy. A thread's whole diff keeps working while it isn't archived.
- An unarchived thread whose refs were pruned while archived has only what was kept.
- Worktree folders no thread knows about, and branches of removed worktrees, are left alone.
