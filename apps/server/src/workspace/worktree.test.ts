import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, makeTempHome, makeTempRepo, removeTempHome } from "@verdandi/testkit";
import { Effect } from "effect";
import { addWorktree, removeWorktree } from "./worktree.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempHome(d);
});
const temp = (d: string) => {
  dirs.push(d);
  return d;
};

test("a worktree with files past 260 characters in a path with spaces is added, kept while dirty, removed with its branch kept, and added again", async () => {
  const repo = temp(makeTempRepo({ "a.txt": "one\n" }));
  // A file whose path in the worktree passes Windows' MAX_PATH, committed with plumbing so only git ever writes it.
  // (Git for Windows can't put a worktree's own folder past MAX_PATH, so the length is in the files.)
  const deep = `app/${"a folder with spaces in its name/".repeat(7)}b.txt`;
  const blob = git(repo, "hash-object", "-w", "--stdin").trim();
  git(repo, "update-index", "--add", "--cacheinfo", `100644,${blob},${deep}`);
  git(repo, "commit", "-q", "-m", "deep");
  git(repo, "-c", "core.longpaths=true", "checkout", "--", "app");
  mkdirSync(join(repo, "app", "src"));
  writeFileSync(join(repo, "app", "src", "c.txt"), "c\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "app");
  const worktrees = join(temp(makeTempHome()), "work trees");
  const branch = "verdandi/thread-1";

  const added = await Effect.runPromise(addWorktree(join(repo, "app"), worktrees, branch));
  expect(join(added.root, deep).length).toBeGreaterThan(260);
  expect(added.path).toBe(join(added.root, "app"));
  expect(git(added.root, "-c", "core.longpaths=true", "status", "--porcelain")).toBe(""); // every file checked out, the deep one too
  // Adding it again (after a crash mid-creation) reuses it.
  expect(await Effect.runPromise(addWorktree(join(repo, "app"), worktrees, branch, added.root))).toEqual(added);

  writeFileSync(join(added.path, "src", "c.txt"), "changed\n");
  const kept = await Effect.runPromise(Effect.flip(removeWorktree(repo, added.root, false)));
  expect(kept.message).toContain("uncommitted changes");
  expect(existsSync(added.root)).toBe(true);

  await Effect.runPromise(removeWorktree(repo, added.root, true));
  expect(existsSync(added.root)).toBe(false);
  expect(git(repo, "branch", "--list", branch).trim()).toBe(branch);
  expect(git(repo, "status", "--porcelain")).toBe("");

  // Again on the kept branch.
  const again = await Effect.runPromise(addWorktree(join(repo, "app"), worktrees, branch, added.root));
  expect(again).toEqual(added);
  expect(git(again.root, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe(branch);
});

test("a folder outside git can't have a worktree, and the message says why", async () => {
  const dir = temp(makeTempHome());
  const error = await Effect.runPromise(Effect.flip(addWorktree(dir, join(dir, "worktrees"), "verdandi/t")));
  expect(error.message).toContain("isn't in a git repository");
});
