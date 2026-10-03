import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempHome } from "./temp-home.ts";

/** Runs git in `cwd` with the user's identity and signing config kept out of it; throws on failure. */
export const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
};

/** A throwaway git repo, its path containing a space, with `files` committed. Remove it with `removeTempHome`. */
export const makeTempRepo = (files: Record<string, string>) => {
  const repo = makeTempHome();
  git(repo, "init", "-q");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "initial");
  return repo;
};

/**
 * The default timeout for a test file whose tests drive turns through git checkpoints, set with
 * `setDefaultTimeout(gitHeavyTimeout)`: such a test spawns git a hundred times or more, and at ~100 ms a spawn on
 * Windows it passes bun's 5 s default.
 */
export const gitHeavyTimeout = 30_000;
