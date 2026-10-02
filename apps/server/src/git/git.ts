import { Data, Effect } from "effect";
import { childEnv } from "../home/child-env.ts";

/** git failed or couldn't start. The message names the cause and the fix. */
export class GitError extends Data.TaggedError("GitError")<{ readonly message: string }> {}

export type GitResult = { readonly stdout: string; readonly stderr: string; readonly code: number };

/** Variables that would point git at another repo or index than the one `cwd` and our own `env` name. */
const inherited = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"];

/**
 * Runs git in `cwd`. No optional locks, so it never refreshes the user's index; literal pathspecs, so
 * `[id].tsx` is a file name, not a glob; paths unquoted; paths past Windows' 260 characters allowed. Fails
 * only when git can't start: a non-zero exit is the caller's to read.
 */
export const git = (cwd: string, args: readonly string[], env: Record<string, string> = {}, input?: string) =>
  Effect.tryPromise({
    try: async (): Promise<GitResult> => {
      const base = Object.fromEntries(Object.entries(childEnv()).filter(([k]) => !inherited.includes(k)));
      const proc = Bun.spawn(
        ["git", "--no-optional-locks", "--literal-pathspecs", "-c", "core.quotePath=false", "-c", "core.longpaths=true", ...args],
        {
          cwd,
          env: { ...base, ...env },
          stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { stdout, stderr, code };
    },
    catch: () => new GitError({ message: `Could not run git in ${cwd}. Install git, put it on PATH and restart verdandid.` }),
  });

export const notARepo = (stderr: string) => /not a git repository/i.test(stderr);

/** A failed git command as an error naming the command and what git said. */
export const gitFailed = (what: string, r: GitResult) =>
  new GitError({ message: `git ${what} failed: ${r.stderr.trim() || `exit code ${r.code}`}` });

/** Runs git and fails unless it exits 0; returns its trimmed stdout. */
export const gitOk = (cwd: string, args: readonly string[], env?: Record<string, string>) =>
  Effect.flatMap(git(cwd, args, env), (r) =>
    r.code === 0
      ? Effect.succeed(r.stdout.trim())
      : Effect.fail(gitFailed(args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c") ?? "", r)),
  );
