import { expect, test } from "bun:test";
import { diffRows, lineDiff } from "./diff.tsx";

const diff = [
  "diff --git a/a.txt b/a.txt",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,2 +1,2 @@",
  " keep",
  "--- was a rule",
  "+++ is a rule",
  "",
].join("\n");

test("header lines are headers, and hunk lines starting with --- or +++ are removed and added", () => {
  const rows = diffRows({ files: [{ path: "a.txt", diff, truncated: true }], omittedFiles: 2 }, new Set());
  expect(rows.map((r) => (r.kind === "line" ? r.line : r.kind))).toEqual([
    "file",
    "meta",
    "meta",
    "meta",
    "hunk",
    "context",
    "del",
    "add",
    "note",
    "note",
  ]);
  expect(rows.at(-1)).toMatchObject({ text: expect.stringContaining("2 more changed files") });
});

test("a line diff keeps shared lines and marks the removed and added ones in order", () => {
  expect(lineDiff("1. Read\n2. Edit a\n3. Test", "1. Read\n2. Edit b\n3. Test\n4. Commit")).toEqual([
    { line: "context", text: "1. Read" },
    { line: "del", text: "2. Edit a" },
    { line: "add", text: "2. Edit b" },
    { line: "context", text: "3. Test" },
    { line: "add", text: "4. Commit" },
  ]);
});

test("a collapsed file shows only its header", () => {
  const rows = diffRows({ files: [{ path: "a.txt", diff, truncated: false }], omittedFiles: 0 }, new Set(["a.txt"]));
  expect(rows).toEqual([{ kind: "file", key: "0", path: "a.txt", expanded: false }]);
});
