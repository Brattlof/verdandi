import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ThreadId, TurnId } from "@verdandi/contracts";
import { Effect } from "effect";
import { GitError, git, gitFailed, gitOk, notARepo } from "../git/git.ts";
import { refPart } from "./refs.ts";

/** Where a thread's checkpoints live: shared by every worktree of the repo, and never on a branch. */
export const threadCheckpoints = (threadId: ThreadId) => `refs/verdandi/checkpoints/${refPart(threadId)}/`;

/** The tree as it was when turn `turnId` started or ended. */
export const checkpointRef = (threadId: ThreadId, turnId: TurnId, at: "start" | "end") =>
  `${threadCheckpoints(threadId)}${refPart(turnId)}/${at}`;

/** Checkpoint commits carry a fixed identity, so they never depend on (or show) the user's git config. */
const identity = {
  GIT_AUTHOR_NAME: "Verdandi",
  GIT_AUTHOR_EMAIL: "verdandi@localhost",
  GIT_COMMITTER_NAME: "Verdandi",
  GIT_COMMITTER_EMAIL: "verdandi@localhost",
};

/**
 * The working tree of the repo holding `cwd` as a git tree: untracked files included, ignored ones not.
 * It's built in a temporary index, so the user's branch, index and stash are never touched; the index is
 * copied first so its stat cache spares hashing unchanged files. Undefined outside a git repo.
 */
export const snapshot = (cwd: string) =>
  Effect.gen(function* () {
    const index = yield* git(cwd, ["rev-parse", "--git-path", "index"]);
    if (index.code !== 0) return notARepo(index.stderr) ? undefined : yield* gitFailed("rev-parse", index);
    const real = resolve(cwd, index.stdout.trim());
    const temp = join(tmpdir(), `verdandi-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: temp };
    return yield* Effect.gen(function* () {
      if (existsSync(real)) copyFileSync(real, temp);
      // `--all` without a pathspec covers the whole repo, whichever folder in it `cwd` is.
      let added = yield* git(cwd, ["add", "--all"], env);
      if (added.code !== 0 && existsSync(temp)) {
        // A copied index can lean on files next to the original (a split index); start from an empty one instead.
        rmSync(temp, { force: true });
        added = yield* git(cwd, ["add", "--all"], env);
      }
      if (added.code !== 0) return yield* gitFailed("add", added);
      return yield* gitOk(cwd, ["write-tree"], env);
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(temp, { force: true }))));
  });

/** Saves the working tree of the repo holding `cwd` as `ref`, and returns its commit. Undefined outside a git repo. */
export const checkpoint = (cwd: string, ref: string) =>
  Effect.gen(function* () {
    const tree = yield* snapshot(cwd);
    if (tree === undefined) return undefined;
    const commit = yield* gitOk(cwd, ["commit-tree", tree, "-m", `Verdandi checkpoint ${ref}`], identity);
    yield* gitOk(cwd, ["update-ref", ref, commit]);
    return commit;
  });

/** The checkpoint refs of `threadId` that exist, by name. */
export const listCheckpoints = (cwd: string, threadId: ThreadId) =>
  Effect.map(
    gitOk(cwd, ["for-each-ref", "--format=%(refname)", threadCheckpoints(threadId)]),
    (out) => new Set(out.split("\n").filter(Boolean)),
  );

/** Where the files a revert replaced are saved, so it can be undone. */
export const revertRef = (threadId: ThreadId, seq: number) => `refs/verdandi/reverts/${refPart(threadId)}/${seq}`;

/**
 * Puts the files under `cwd` back as checkpoint `ref` has them: changed files rewritten, files it doesn't have
 * deleted, line endings as git checks them out (`core.autocrlf`, `.gitattributes`), as a checkout of a commit
 * would. Written through a temporary index, so the user's index stays as it was; ignored files are left alone.
 */
export const restore = (cwd: string, ref: string) =>
  Effect.gen(function* () {
    const current = yield* snapshot(cwd);
    if (current === undefined) return yield* new GitError({ message: `${cwd} is not in a git repository, so it has no checkpoints.` });
    if ((yield* git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code !== 0) {
      return yield* new GitError({
        message: `There's no checkpoint ${ref}: its turn ran before Verdandi saved checkpoints, saving it failed, or the cleanup policy in gc.yaml removed it. The files were left as they are.`,
      });
    }
    const top = resolve(yield* gitOk(cwd, ["rev-parse", "--show-toplevel"]));
    // From `cwd`, `.` limits it to the project's folder; paths come back relative to the repo's top level.
    const changed = yield* git(cwd, ["diff", "--name-status", "-z", "--no-renames", "--no-relative", current, ref, "--", "."]);
    if (changed.code !== 0) return yield* gitFailed("diff", changed);
    const fields = changed.stdout.split("\0");
    const written: string[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [status, path] = [fields[i], fields[i + 1] ?? ""];
      if (status === "D") rmSync(join(top, path), { force: true, recursive: true });
      else written.push(path);
    }
    if (written.length === 0) return;
    const temp = join(tmpdir(), `verdandi-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: temp };
    yield* Effect.gen(function* () {
      yield* gitOk(top, ["read-tree", ref], env);
      const out = yield* git(top, ["checkout-index", "--force", "-z", "--stdin"], env, `${written.join("\0")}\0`);
      if (out.code !== 0) return yield* gitFailed("checkout-index", out);
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(temp, { force: true }))));
  });
