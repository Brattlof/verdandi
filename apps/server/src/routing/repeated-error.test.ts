import { expect, test } from "bun:test";
import { normalizeError, repeatedError } from "./repeated-error.ts";

test("errors that differ only in paths, line numbers and ids normalize alike", () => {
  expect(normalizeError("Error: ENOENT: no such file '/tmp/a/b.ts' at line 12:4 (request 3f2a9c1e-77b0-4c1d-9e2f-0a1b2c3d4e5f)")).toBe(
    normalizeError("Error: ENOENT: no such file 'C:\\Users\\x\\b.ts' at line 7:1  (request 9d8c7b6a-1111-4222-8333-444455556666)\n"),
  );
  expect(normalizeError("Cannot find module ./src/x.ts")).not.toBe(normalizeError("Type 'string' is not assignable to 'number'"));
});

test("an error repeated n times is returned with its latest text and count; varied ones aren't", () => {
  const errors = [
    { tool: "Bash", error: "bun: command not found: /a/1" },
    { tool: "Read", error: "bun: command not found: /a/1" },
    { tool: "Bash", error: "bun: command not found: /b/2" },
    { tool: "Bash", error: "bun: command not found: /c/3" },
  ];
  expect(repeatedError(errors, 3)).toEqual({ kind: "repeated-error", tool: "Bash", error: "bun: command not found: /c/3", count: 3 });
  expect(repeatedError(errors, 4)).toBeUndefined();
  expect(repeatedError(errors, 0)).toBeUndefined();
});
