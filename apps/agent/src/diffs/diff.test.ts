import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitHeavyTimeout, makeTempHome, makeTempRepo, removeTempHome } from "@verdandi/testkit";
import { Effect } from "effect";
import { snapshot } from "../checkpoints/checkpoint.ts";
import { diffTrees, editedFiles, limits } from "./diff.ts";

setDefaultTimeout(gitHeavyTimeout);

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

/** The repo's tree now, as a diff can take it. */
const tree = async (dir: string) => (await Effect.runPromise(snapshot(dir))) ?? "";

describe("diffTrees", () => {
  test("shows only the changed lines of a CRLF file, and new files unless ignored", async () => {
    const dir = repo({ "a b.txt": "one\r\ntwo\r\n", ".gitignore": "*.log\n" });
    const before = await tree(dir);
    appendFileSync(join(dir, "a b.txt"), "three\r\n");
    writeFileSync(join(dir, "new [id].txt"), "hello\n");
    writeFileSync(join(dir, "new i.txt"), "hi\n");
    writeFileSync(join(dir, "debug.log"), "noise\n");

    const all = await Effect.runPromise(diffTrees(dir, before, await tree(dir)));
    expect(all.files.map((f) => f.path)).toEqual(["a b.txt", "new [id].txt", "new i.txt"]);
    expect(all.files.map((f) => changedLines(f.diff))).toEqual([["+three"], ["+hello"], ["+hi"]]);
  });

  test("a project in a subfolder sees only its own files, relative to it", async () => {
    const dir = repo({ "root.txt": "r\n" });
    mkdirSync(join(dir, "app"));
    const before = await tree(dir);
    writeFileSync(join(dir, "root.txt"), "changed\n");
    writeFileSync(join(dir, "app", "x.txt"), "x\n");
    const view = await Effect.runPromise(diffTrees(join(dir, "app"), before, await tree(dir)));
    expect(view.files.map((f) => f.path)).toEqual(["x.txt"]);
  });

  test("cuts large diffs on a line break and counts the files left out", async () => {
    const dir = repo({ "keep.txt": "x\n" });
    const before = await tree(dir);
    const big = "line of text that is long enough to add up\n".repeat(4000);
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, `big${String(i).padStart(2, "0")}.txt`), big);

    const view = await Effect.runPromise(diffTrees(dir, before, await tree(dir)));
    expect(view.files[0]?.truncated).toBe(true);
    expect(view.files[0]?.diff.length).toBeLessThanOrEqual(limits.fileBytes);
    expect(view.files[0]?.diff.endsWith("\n")).toBe(true);
    expect(view.omittedFiles).toBeGreaterThan(0);
    expect(view.files.length + view.omittedFiles).toBe(12);
    expect(view.files.reduce((n, f) => n + f.diff.length, 0)).toBeLessThanOrEqual(limits.totalBytes);
  });
});
test("editedFiles splits the files that file tools touched into the project's and the others", () => {
  const project = join("/", "work", "my repo");
  const call = (name: string, input: unknown) => ({ kind: "tool.call" as const, toolUseId: name, name, input });
  const files = editedFiles(project, [
    call("Edit", { file_path: join(project, "src", "a b.ts") }),
    call("Write", { file_path: join(project, "src", "a b.ts") }),
    call("NotebookEdit", { notebook_path: join(project, "..n.ipynb") }),
    call("Read", { file_path: join(project, "read.ts") }),
    call("Write", { file_path: join("/", "elsewhere", "x.ts") }),
  ]);
  expect(files).toEqual({ inside: ["src/a b.ts", "..n.ipynb"], outside: [resolve("/", "elsewhere", "x.ts")] });
});

test("editedFiles matches a file named through a symlink to the project", () => {
  const dir = makeTempHome();
  dirs.push(dir);
  const project = join(dir, "real project");
  mkdirSync(project);
  symlinkSync(project, join(dir, "link"), "junction"); // like macOS /tmp → /private/tmp
  const input = { file_path: join(dir, "link", "new.ts") };
  expect(editedFiles(project, [{ kind: "tool.call", toolUseId: "1", name: "Write", input }])).toEqual({ inside: ["new.ts"], outside: [] });
});
