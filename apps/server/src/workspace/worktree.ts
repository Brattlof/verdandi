import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { WorktreeView } from "@verdandi/contracts";
import { Effect, Result, Schema } from "effect";
import { GitError, git, gitFailed, gitOk, notARepo } from "./git.ts";

/** Lets git make worktree paths past Windows' 260-character limit. */
const longPaths = ["-c", "core.longpaths=true"];

/** `.verdandi/worktree.yaml` in the project: `setup` runs once in each new worktree of it, e.g. `bun install`. */
const WorktreeFile = Schema.Struct({ setup: Schema.optionalKey(Schema.String) });

export const worktreeFile = (projectPath: string) => join(projectPath, ".verdandi", "worktree.yaml");

/**
 * The project's worktree setup command, read from the project folder (not the worktree) when a worktree is
 * created; undefined when there's none. A broken file is reported naming the file.
 */
export const worktreeSetup = (projectPath: string): Result.Result<string | undefined, string> => {
  const file = worktreeFile(projectPath);
  if (!existsSync(file)) return Result.succeed(undefined);
  try {
    const data = Schema.decodeUnknownSync(WorktreeFile)(Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}, { onExcessProperty: "error" });
    return Result.succeed(data.setup?.trim() || undefined);
  } catch (e) {
    return Result.fail(`${file}: ${e instanceof Error ? e.message : String(e)}\nFix the file, then recreate the worktree.`);
  }
};

/**
 * Adds the worktree of `branch` for the repo holding `projectPath`, at `root`, by default
 * `<worktreesDir>/<repo>/<branch>`: on a new branch from `HEAD`, or on `branch` when it already exists.
 * Returns where it is and the project's folder inside it. A worktree already at `root` on `branch` is
 * reused, so a creation verdandid was stopped in the middle of can run again.
 */
export const addWorktree = (projectPath: string, worktreesDir: string, branch: string, root?: string) =>
  Effect.gen(function* () {
    const top = yield* git(projectPath, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) {
      return yield* notARepo(top.stderr)
        ? new GitError({
            message: `${projectPath} isn't in a git repository, so it can't have worktrees. Run \`git init\` there and commit once, or start the thread without a worktree.`,
          })
        : gitFailed("rev-parse", top);
    }
    const head = yield* git(projectPath, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.code !== 0) {
      return yield* new GitError({
        message: `${projectPath} has no commits yet, so a worktree has nothing to start from. Commit once, then retry.`,
      });
    }
    const repo = resolve(top.stdout.trim());
    const at = root ?? join(worktreesDir, basename(repo), ...branch.split("/"));
    // git prints the top level with symlinks resolved, so the project's subfolder is found from its real path too.
    const path = join(at, relative(repo, realpathSync.native(projectPath)));
    if (existsSync(at)) {
      const on = yield* git(at, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (on.code === 0 && on.stdout.trim() === branch) return { root: at, path };
      return yield* new GitError({ message: `${at} already exists and isn't this thread's worktree. Move it away, then retry.` });
    }
    const exists = (yield* git(projectPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
    yield* gitOk(projectPath, [...longPaths, "worktree", "add", ...(exists ? [at, branch] : ["-b", branch, at, "HEAD"])]);
    return { root: at, path };
  });

/**
 * Removes the worktree at `root` and keeps its branch. git refuses while it has uncommitted changes or
 * untracked files, unless `force`. A worktree folder someone already deleted is pruned from git's list.
 */
export const removeWorktree = (projectPath: string, root: string, force: boolean) =>
  Effect.gen(function* () {
    if (!existsSync(root)) {
      yield* gitOk(projectPath, ["worktree", "prune"]);
      return;
    }
    const removed = yield* git(projectPath, [...longPaths, "worktree", "remove", ...(force ? ["--force"] : []), root]);
    if (removed.code === 0) return;
    if (/modified or untracked files|--force/.test(removed.stderr)) {
      return yield* new GitError({
        message: `The worktree at ${root} has uncommitted changes or untracked files, so it was kept. Commit or move them, or remove it anyway (Remove anyway in the web UI, \`verdandi chat --remove-worktree --force\` for the thread).`,
      });
    }
    return yield* gitFailed("worktree remove", removed);
  });

/**
 * Where a thread's harness, checkpoints, diffs and terminals run, from its `threads.worktree` column: the
 * project's folder inside its worktree once it has one, else the project folder.
 */
export const threadFolder = (projectPath: string, worktree: string | null) =>
  (worktree === null ? undefined : (JSON.parse(worktree) as WorktreeView).path) ?? projectPath;
