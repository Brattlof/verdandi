import { afterEach, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadId, TurnId } from "@verdandi/contracts";
import { git, makeTempHome, makeTempRepo, removeTempHome } from "@verdandi/testkit";
import { Effect } from "effect";
import { checkpoint, checkpointRef, listCheckpoints } from "./checkpoint.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempHome(d);
});

test("checkpointing a dirty tree saves it whole and leaves the branch, index, status and stash alone", async () => {
  const dir = makeTempRepo({ "a.txt": "one\n", ".gitignore": "*.log\n" });
  dirs.push(dir);
  appendFileSync(join(dir, "a.txt"), "stashed\n");
  git(dir, "stash", "-q");
  appendFileSync(join(dir, "a.txt"), "staged\n");
  git(dir, "add", "a.txt");
  appendFileSync(join(dir, "a.txt"), "unstaged\n");
  writeFileSync(join(dir, "new.txt"), "untracked\n");
  writeFileSync(join(dir, "debug.log"), "ignored\n");
  const state = () => [
    git(dir, "status", "--porcelain"),
    git(dir, "diff", "--cached"),
    git(dir, "stash", "list"),
    git(dir, "rev-parse", "HEAD"),
  ];
  const before = state();

  // An id with spaces, dots and slashes still makes one valid ref of its own.
  const ref = checkpointRef("t 1/../x.lock" as ThreadId, "turn 1" as TurnId, "end");
  const commit = await Effect.runPromise(checkpoint(dir, ref));

  expect(state()).toEqual(before);
  expect(git(dir, "rev-parse", ref).trim()).toBe(commit ?? "");
  expect(git(dir, "ls-tree", "--name-only", ref).split("\n").filter(Boolean)).toEqual([".gitignore", "a.txt", "new.txt"]);
  expect(git(dir, "show", `${ref}:a.txt`)).toBe("one\nstaged\nunstaged\n");
  expect(await Effect.runPromise(listCheckpoints(dir, "t 1/../x.lock" as ThreadId))).toEqual(new Set([ref]));
});

test("a folder outside git has no checkpoint", async () => {
  const dir = makeTempHome();
  dirs.push(dir);
  expect(await Effect.runPromise(checkpoint(dir, checkpointRef("t" as ThreadId, "u" as TurnId, "start")))).toBeUndefined();
});
