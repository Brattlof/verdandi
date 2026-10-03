import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DiffUnavailable, type DiffView, type FileDiff, type Item, type ThreadId, type TurnId } from "@verdandi/contracts";
import { Effect } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import { checkpointRef, listCheckpoints, snapshot } from "../checkpoints/checkpoint.ts";
import { type GitError, git, gitFailed, notARepo } from "../git/git.ts";
import { threadFolder } from "../worktrees/worktree.ts";

/** Payload limits: one file's diff, and the whole response. */
export const limits = { fileBytes: 64 * 1024, totalBytes: 512 * 1024 };

/** File tools and the input key that holds the path: Claude Code's, then the native harness's. A harness with other names adds them here. */
const fileTools: Record<string, string> = {
  Edit: "file_path",
  MultiEdit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
  write_file: "path",
  edit_file: "path",
};

/** `path` with symlinks resolved as far up as it exists, so `/tmp/x` and `/private/tmp/x` (macOS) match. */
const real = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
};

/**
 * The project-relative paths, `/`-separated, a turn's file tools touched; paths outside the project are
 * dropped. In a folder outside git, which has no checkpoints, verifiers run when this is non-empty.
 */
export const editedPaths = (projectPath: string, items: readonly Item[]) => {
  const root = real(projectPath);
  const paths = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tool.call") continue;
    const key = fileTools[item.name];
    const path = key && typeof item.input === "object" && item.input !== null ? (item.input as Record<string, unknown>)[key] : undefined;
    if (typeof path !== "string") continue;
    const rel = relative(root, real(resolve(projectPath, path)));
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) paths.add(rel.split(sep).join("/"));
  }
  return [...paths];
};

const diffFlags = ["--no-color", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"];

/** `diff --git a/X b/X` names X twice (renames are off), so X is the first half. Quoted names stay quoted. */
const headerPath = (chunk: string) => {
  const names = chunk.slice("diff --git ".length, chunk.indexOf("\n"));
  const quoted = names.startsWith('"');
  const half = (names.length - 1) / 2;
  return quoted ? `"${names.slice(3, half)}` : names.slice(2, half);
};

/** Cuts at the last line break within `max`, so a truncated diff ends on a whole line. */
const cut = (diff: string, max: number) => {
  if (diff.length <= max) return { diff, truncated: false };
  const end = diff.lastIndexOf("\n", max);
  return { diff: diff.slice(0, end > 0 ? end + 1 : 0), truncated: true };
};

const gitFailedDiff = (e: GitError) => new DiffUnavailable({ reason: "GitFailed", message: e.message });

/**
 * `head` against `base` (commits or trees), one unified diff per file under `cwd`, paths relative to it.
 * Each file is cut at `limits.fileBytes` and the files past `limits.totalBytes` are only counted.
 */
export const diffTrees = (cwd: string, base: string, head: string): Effect.Effect<DiffView, DiffUnavailable> =>
  Effect.gen(function* () {
    const r = yield* git(cwd, ["diff", ...diffFlags, "--relative", base, head, "--"]);
    if (r.code !== 0) return yield* gitFailed("diff", r);
    const chunks = r.stdout
      .split(/^(?=diff --git )/m)
      .filter((c) => c.startsWith("diff --git "))
      .map((chunk) => ({ path: headerPath(chunk), chunk }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // ponytail: the whole diff is read before it's cut; fine for an agent's edits. Upgrade to a streamed
    // read when huge generated files show up.
    const files: FileDiff[] = [];
    let budget = limits.totalBytes;
    for (const [i, { path, chunk }] of chunks.entries()) {
      if (budget <= 0) return { files, omittedFiles: chunks.length - i };
      const { diff, truncated } = cut(chunk, Math.min(limits.fileBytes, budget));
      budget -= diff.length + path.length;
      files.push({ path, diff, truncated });
    }
    return { files, omittedFiles: 0 };
  }).pipe(Effect.catchTag("GitError", (e) => Effect.fail(gitFailedDiff(e))));

const notGit = (cwd: string) =>
  new DiffUnavailable({
    reason: "NotAGitRepo",
    message: `${cwd} is not a git repository, so Verdandi can't checkpoint or diff it. Run \`git init\` there, then start a new turn.`,
  });

/** The checkpoints `threadId` has in the repo holding `cwd`, or why there can be none: the folder is gone or isn't in a git repo. */
const checkpointsIn = (cwd: string, threadId: ThreadId) =>
  Effect.gen(function* () {
    if (!existsSync(cwd)) {
      return yield* new DiffUnavailable({ reason: "NotAGitRepo", message: `The project folder ${cwd} does not exist.` });
    }
    const repo = yield* git(cwd, ["rev-parse", "--git-dir"]);
    if (repo.code !== 0) return yield* notARepo(repo.stderr) ? notGit(cwd) : gitFailed("rev-parse", repo);
    return yield* listCheckpoints(cwd, threadId);
  }).pipe(Effect.catchTag("GitError", (e) => Effect.fail(gitFailedDiff(e))));

/** The working tree now, as a tree. */
const workingTree = (cwd: string) =>
  snapshot(cwd).pipe(
    Effect.catchTag("GitError", (e) => Effect.fail(gitFailedDiff(e))),
    Effect.flatMap((tree) => (tree === undefined ? Effect.fail(notGit(cwd)) : Effect.succeed(tree))),
  );

/**
 * `DiffGet` (ADR 0015). With `turnId`: what that turn changed, its end checkpoint against its start (a
 * running turn's end is the working tree now), so the user's own edits between turns never show. Without:
 * the working tree against the thread's first checkpoint, or `HEAD` for a thread from before checkpoints.
 */
export const threadDiff = (
  threadId: ThreadId,
  turnId: TurnId | undefined,
): Effect.Effect<DiffView, DiffUnavailable | SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [thread] = yield* sql<{ path: string; worktree: string | null }>`
      select p.path, t.worktree from threads t join projects p on p.id = t.project_id where t.id = ${threadId}`;
    if (!thread) return yield* new DiffUnavailable({ reason: "ThreadNotFound", message: `Thread ${threadId} does not exist.` });
    const turns = yield* sql<{ id: TurnId; status: string }>`
      select id, status from turns where thread_id = ${threadId} order by started_at, rowid`;
    // A worktree shares its repo's refs, so its turns' checkpoints still diff from the project folder once it's removed.
    const cwd = turnId === undefined ? threadFolder(thread.path, thread.worktree) : thread.path;
    const saved = yield* checkpointsIn(cwd, threadId);
    if (turnId === undefined) {
      const first = turns.map((t) => checkpointRef(threadId, t.id, "start")).find((ref) => saved.has(ref));
      if (first) return yield* diffTrees(cwd, first, yield* workingTree(cwd));
      const head = yield* git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).pipe(
        Effect.catchTag("GitError", (e) => Effect.fail(gitFailedDiff(e))),
      );
      if (head.code !== 0) {
        return yield* new DiffUnavailable({
          reason: "NoCheckpoint",
          message: `${cwd} has no commits and this thread no checkpoints yet, so there is nothing to diff against. Send a turn or commit once, then try again.`,
        });
      }
      return yield* diffTrees(cwd, "HEAD", yield* workingTree(cwd));
    }
    const turn = turns.find((t) => t.id === turnId);
    if (!turn) return yield* new DiffUnavailable({ reason: "TurnNotFound", message: `Turn ${turnId} is not in thread ${threadId}.` });
    const start = checkpointRef(threadId, turnId, "start");
    const end = checkpointRef(threadId, turnId, "end");
    if (!saved.has(start) || (turn.status !== "running" && !saved.has(end))) {
      return yield* new DiffUnavailable({
        reason: "NoCheckpoint",
        message: `Turn ${turnId} has no checkpoint: it ran before Verdandi saved them, saving one failed (verdandid's log says why), or the cleanup policy in gc.yaml removed it. The thread's whole diff still works.`,
      });
    }
    return yield* diffTrees(cwd, start, turn.status === "running" ? yield* workingTree(threadFolder(thread.path, thread.worktree)) : end);
  });
