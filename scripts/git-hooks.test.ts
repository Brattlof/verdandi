import { expect, test } from "bun:test";
import { messageProblem, titleProblem } from "./git-hooks";

test("a one-line imperative title passes, with or without an area", () => {
  expect(messageProblem("Escalate a task that keeps hitting the same tool error\n")).toBeUndefined();
  expect(titleProblem("router: Price cache reads at list price")).toBeUndefined();
});

test("a body or a trailer is refused", () => {
  expect(messageProblem("Add decision layer\n\nIt answers typed questions.\n")).toContain("one line");
  expect(messageProblem("Add decision layer\n\nCo-Authored-By: Someone <a@b.c>\n")).toContain("one line");
});

test("git's comments and the verbose diff aren't part of the message", () => {
  const message =
    "Add decision layer\n\n# Please enter the commit message\n# ------------------------ >8 ------------------------\ndiff --git a/x b/x\n+added\n";
  expect(messageProblem(message)).toBeUndefined();
});

test("a lowercase, period-terminated, overlong or empty title is refused", () => {
  expect(titleProblem("add decision layer")).toContain("capital");
  expect(titleProblem("Add decision layer.")).toContain("period");
  expect(titleProblem(`Add ${"very ".repeat(20)}long title`)).toContain("characters");
  expect(messageProblem("# only a comment\n")).toContain("empty");
});
