import { expect, test } from "bun:test";
import { lineDiff } from "./text.ts";

test("a line diff keeps shared lines and marks the removed and added ones in order", () => {
  expect(lineDiff("1. Read\n2. Edit a\n3. Test", "1. Read\n2. Edit b\n3. Test\n4. Commit")).toEqual([
    { line: "context", text: "1. Read" },
    { line: "del", text: "2. Edit a" },
    { line: "add", text: "2. Edit b" },
    { line: "context", text: "3. Test" },
    { line: "add", text: "4. Commit" },
  ]);
});

test("a new or deleted file is all added or all removed lines", () => {
  expect(lineDiff("", "a\nb\n")).toEqual([
    { line: "add", text: "a" },
    { line: "add", text: "b" },
  ]);
  expect(lineDiff("a\n", "")).toEqual([{ line: "del", text: "a" }]);
});
