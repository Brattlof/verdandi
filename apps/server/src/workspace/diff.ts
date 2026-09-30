import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DiffUnavailable, type DiffView, type FileDiff, type Item, type ThreadId, type TurnId } from "@verdandi/contracts";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import { loadThreadView } from "../orchestration/projector.ts";

/** Payload limits: one file's diff, and the whole response. */
export const limits = { fileBytes: 64 * 1024, totalBytes: 512 * 1024 };

/** File tools and the input key that holds the path: Claude Code's. A harness with other names adds them here. */
const fileTools: Record<string, string> = { Edit: "file_path", MultiEdit: "file_path", Write: "file_path", NotebookEdit: "notebook_path" };

/** `path` with symlinks resolved as far up as it exists, so `/tmp/x` and `/private/tmp/x` (macOS) match. */
const real = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
};

/** The project-relative paths, `/`-separated, a turn's file tools touched. Paths outside the project are dropped. */
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

const gitMissing = new DiffUnavailable({
  reason: "GitFailed",
  message: "Could not run git. Install git, put it on PATH and restart verdandid.",
});

/**
 * Runs git read-only: no optional locks, so it never refreshes the user's index; literal pathspecs, so
 * `[id].tsx` is a file name, not a glob; fixed `a/` `b/` prefixes whatever the user's diff config says.
 */
const git = (cwd: string, args: readonly string[]) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["git", "--no-optional-locks", "--literal-pathspecs", "-c", "core.quotePath=false", ...args], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code };
    },
    catch: () => gitMissing,
  });

const diffFlags = ["--no-color", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"];

const failed = (what: string, stderr: string) =>
  new DiffUnavailable({ reason: "GitFailed", message: `git ${what} failed: ${stderr.trim() || "no output"}` });

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

/**
 * The working tree of `projectPath` against `HEAD`, one unified diff per file, new untracked files
 * included (ignored ones are not). `paths` narrows it to those project-relative files.
 */
export const diffProject = (projectPath: string, paths?: readonly string[]): Effect.Effect<DiffView, DiffUnavailable> =>
  Effect.gen(function* () {
    if (paths?.length === 0) return { files: [], omittedFiles: 0 };
    if (!existsSync(projectPath)) {
      return yield* new DiffUnavailable({ reason: "NotAGitRepo", message: `The project folder ${projectPath} does not exist.` });
    }
    const head = yield* git(projectPath, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.code !== 0 && /not a git repository/i.test(head.stderr)) {
      return yield* new DiffUnavailable({
        reason: "NotAGitRepo",
        message: `${projectPath} is not a git repository, so there is nothing to diff against. Run \`git init\` there and commit, then try again.`,
      });
    }
    if (head.code === 1) {
      return yield* new DiffUnavailable({
        reason: "GitFailed",
        message: `${projectPath} has no commits yet, so there is nothing to diff against. Commit once, then try again.`,
      });
    }
    if (head.code !== 0) return yield* failed("rev-parse", head.stderr);

    const spec = ["--", ...(paths ?? [])];
    const tracked = yield* git(projectPath, ["diff", "HEAD", "--relative", ...diffFlags, ...spec]);
    if (tracked.code !== 0) return yield* failed("diff", tracked.stderr);
    const listed = yield* git(projectPath, ["ls-files", "-z", "--others", "--exclude-standard", ...spec]);
    if (listed.code !== 0) return yield* failed("ls-files", listed.stderr);

    const chunks = tracked.stdout.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
    const changed = [
      ...chunks.map((chunk) => ({ path: headerPath(chunk), diff: Effect.succeed(chunk) })),
      ...listed.stdout
        .split("\0")
        .filter(Boolean)
        .map((path) => ({
          path,
          // Exit code 1 means "differs", which a new file always does.
          diff: git(projectPath, ["diff", "--no-index", ...diffFlags, "--", "/dev/null", path]).pipe(
            Effect.flatMap((r) => (r.code <= 1 ? Effect.succeed(r.stdout) : Effect.fail(failed("diff --no-index", r.stderr)))),
          ),
        })),
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    // ponytail: one git process per untracked file, and each diff is read whole before it's cut; fine for
    // an agent's edits. Upgrade to a temporary index (`GIT_INDEX_FILE` + `add -N`) and a streamed read when
    // threads with thousands of new files or huge generated files show up.
    const files: FileDiff[] = [];
    let budget = limits.totalBytes;
    for (const [i, file] of changed.entries()) {
      if (budget <= 0) return { files, omittedFiles: changed.length - i };
      const { diff, truncated } = cut(yield* file.diff, Math.min(limits.fileBytes, budget));
      budget -= diff.length + file.path.length;
      files.push({ path: file.path, diff, truncated });
    }
    return { files, omittedFiles: 0 };
  });

/** `DiffGet`: the thread's project diff, or with `turnId` only the files that turn edited. */
export const threadDiff = (
  threadId: ThreadId,
  turnId: TurnId | undefined,
): Effect.Effect<DiffView, DiffUnavailable | SqlError.SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const thread = yield* loadThreadView(threadId);
    if (!thread) return yield* new DiffUnavailable({ reason: "ThreadNotFound", message: `Thread ${threadId} does not exist.` });
    if (turnId === undefined) return yield* diffProject(thread.projectPath);
    const turn = thread.turns.find((t) => t.turnId === turnId);
    if (!turn) return yield* new DiffUnavailable({ reason: "TurnNotFound", message: `Turn ${turnId} is not in thread ${threadId}.` });
    return yield* diffProject(thread.projectPath, editedPaths(thread.projectPath, turn.items));
  });
