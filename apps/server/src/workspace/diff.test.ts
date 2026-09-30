import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempHome, makeTempRepo, removeTempHome } from "@verdandi/testkit";
import { Effect } from "effect";
import { diffProject, editedPaths, limits } from "./diff.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempHome(d);
});
const repo = (files: Record<string, string>) => {
  const dir = makeTempRepo(files);
  dirs.push(dir);
  return dir;
};

/** The added and removed lines of a unified diff, without line endings. */
const changedLines = (diff: string) =>
  diff
    .split("\n")
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
    .map((l) => l.replace(/\r$/, ""));

describe("diffProject", () => {
  test("shows only the changed lines of a CRLF file, and new files unless ignored", async () => {
    const dir = repo({ "a b.txt": "one\r\ntwo\r\n", ".gitignore": "*.log\n" });
    appendFileSync(join(dir, "a b.txt"), "three\r\n");
    writeFileSync(join(dir, "new [id].txt"), "hello\n");
    writeFileSync(join(dir, "new i.txt"), "hi\n");
    writeFileSync(join(dir, "debug.log"), "noise\n");

    const all = await Effect.runPromise(diffProject(dir));
    expect(all.files.map((f) => f.path)).toEqual(["a b.txt", "new [id].txt", "new i.txt"]);
    expect(all.files.map((f) => changedLines(f.diff))).toEqual([["+three"], ["+hello"], ["+hi"]]);

    // `[id]` is a file name, not a glob matching `new i.txt`.
    const one = await Effect.runPromise(diffProject(dir, ["new [id].txt"]));
    expect(one.files.map((f) => f.path)).toEqual(["new [id].txt"]);
  });

  test("cuts large diffs on a line break and counts the files left out", async () => {
    const dir = repo({ "keep.txt": "x\n" });
    const big = "line of text that is long enough to add up\n".repeat(4000);
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `big${String(i).padStart(2, "0")}.txt`), big);

    const view = await Effect.runPromise(diffProject(dir));
    expect(view.files[0]?.truncated).toBe(true);
    expect(view.files[0]?.diff.length).toBeLessThanOrEqual(limits.fileBytes);
    expect(view.files[0]?.diff.endsWith("\n")).toBe(true);
    expect(view.omittedFiles).toBeGreaterThan(0);
    expect(view.files.length + view.omittedFiles).toBe(12);
    expect(view.files.reduce((n, f) => n + f.diff.length, 0)).toBeLessThanOrEqual(limits.totalBytes);
  });

  test("a folder that isn't a git repo fails with the fix", async () => {
    const dir = makeTempHome();
    dirs.push(dir);
    const error = await Effect.runPromise(Effect.flip(diffProject(dir)));
    expect(error.reason).toBe("NotAGitRepo");
    expect(error.message).toContain("git init");
  });
});

test("editedPaths keeps the project's files that file tools touched", () => {
  const project = join("/", "work", "my repo");
  const call = (name: string, input: unknown) => ({ kind: "tool.call" as const, toolUseId: name, name, input });
  const paths = editedPaths(project, [
    call("Edit", { file_path: join(project, "src", "a b.ts") }),
    call("Write", { file_path: join(project, "src", "a b.ts") }),
    call("NotebookEdit", { notebook_path: join(project, "..n.ipynb") }),
    call("Read", { file_path: join(project, "read.ts") }),
    call("Write", { file_path: join("/", "elsewhere", "x.ts") }),
  ]);
  expect(paths).toEqual(["src/a b.ts", "..n.ipynb"]);
});

test("editedPaths matches a file named through a symlink to the project", () => {
  const dir = makeTempHome();
  dirs.push(dir);
  const project = join(dir, "real project");
  mkdirSync(project);
  symlinkSync(project, join(dir, "link"), "junction"); // like macOS /tmp → /private/tmp
  const input = { file_path: join(dir, "link", "new.ts") };
  expect(editedPaths(project, [{ kind: "tool.call", toolUseId: "1", name: "Write", input }])).toEqual(["new.ts"]);
});
