import { expect, test } from "bun:test";
import { messageProblem, titleProblem } from "./git-hooks";

test("a one-line conventional header passes, with or without a scope or a breaking mark", () => {
  expect(messageProblem("fix(routing): escalate a task that keeps hitting the same tool error\n")).toBeUndefined();
  expect(titleProblem("docs: write down the trust model")).toBeUndefined();
  expect(titleProblem("feat(contracts)!: drop v1 turn events")).toBeUndefined();
  expect(titleProblem("fix(rpc): RPC size limit no longer drops frames")).toBeUndefined();
});

test("a body or a trailer is refused", () => {
  expect(messageProblem("feat: add decision layer\n\nIt answers typed questions.\n")).toContain("one line");
  expect(messageProblem("feat: add decision layer\n\nCo-Authored-By: Someone <a@b.c>\n")).toContain("one line");
});

test("git's comments and the verbose diff aren't part of the message", () => {
  const message =
    "feat: add decision layer\n\n# Please enter the commit message\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n+added\n";
  expect(messageProblem(message)).toBeUndefined();
});

test("a header without a known type, in sentence case, period-terminated, overlong or empty is refused", () => {
  expect(titleProblem("Add decision layer")).toContain("type");
  expect(titleProblem("feature: add decision layer")).toContain("type");
  expect(titleProblem("feat: Add decision layer")).toContain("lowercase");
  expect(titleProblem("feat: add decision layer.")).toContain("period");
  expect(titleProblem(`feat: add ${"very ".repeat(20)}long title`)).toContain("characters");
  expect(messageProblem("# only a comment\n")).toContain("empty");
});
