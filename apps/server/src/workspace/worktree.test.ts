import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

test("a worktree past 260 characters with spaces is added, kept while dirty, removed with its branch kept, and added again", async () => {
  const repo = temp(makeTempRepo({ "a.txt": "one\n" }));
  mkdirSync(join(repo, "app"));
  writeFileSync(join(repo, "app", "b.txt"), "b\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "app");
  // Windows' MAX_PATH is 260: the worktree's files sit past it.
  const worktrees = join(temp(makeTempHome()), "a folder with spaces ".repeat(6).trim(), "and another long one ".repeat(4).trim());
  const branch = "verdandi/thread-1";

  const added = await Effect.runPromise(addWorktree(join(repo, "app"), worktrees, branch));
  expect(join(added.root, "app", "b.txt").length).toBeGreaterThan(260);
  expect(added.path).toBe(join(added.root, "app"));
  expect(readFileSync(join(added.path, "b.txt"), "utf8")).toBe("b\n");
  // Adding it again (after a crash mid-creation) reuses it.
  expect(await Effect.runPromise(addWorktree(join(repo, "app"), worktrees, branch, added.root))).toEqual(added);

  writeFileSync(join(added.path, "b.txt"), "changed\n");
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
