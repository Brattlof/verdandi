import { expect, test } from "bun:test";
import type { ProjectId, ThreadId, ThreadSummary } from "@verdandi/contracts";
import { threadList } from "./thread-list.ts";

const summary = (threadId: string, projectId: string, title: string, busy = false): ThreadSummary => ({
  threadId: threadId as ThreadId,
  projectId: projectId as ProjectId,
  title,
  busy,
  lastActivityAt: "2026-09-30T09:15:42.000Z",
  route: { harness: "fake", model: "fake", effort: "low" },
});

test("groups threads under their project in feed order", () => {
  const projects = [
    { projectId: "a" as ProjectId, path: "C:/Users/a b/one" },
    { projectId: "b" as ProjectId, path: "/home/b/two" },
  ];
  const out = threadList(projects, [summary("t1", "b", "fix tests", true), summary("t2", "a", ""), summary("t3", "b", "add feed")]);
  expect(out).toBe(
    [
      "/home/b/two",
      "  t1  busy  2026-09-30 09:15  fix tests",
      "  t3  idle  2026-09-30 09:15  add feed",
      "",
      "C:/Users/a b/one",
      "  t2  idle  2026-09-30 09:15  (no turns yet)",
      "",
    ].join("\n"),
  );
});
