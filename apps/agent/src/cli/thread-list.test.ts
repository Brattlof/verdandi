import { expect, test } from "bun:test";
import type { ProjectId, SessionHit, ThreadId, ThreadSummary, TurnId } from "@verdandi/contracts";
import { hitsText } from "../search/search-cli.ts";
import { threadList } from "./thread-list.ts";

const summary = (threadId: string, projectId: string, title: string, busy = false, meteredUsd = 0): ThreadSummary => ({
  threadId: threadId as ThreadId,
  projectId: projectId as ProjectId,
  title,
  busy,
  archived: false,
  lastActivityAt: "2026-09-30T09:15:42.000Z",
  route: { harness: "fake", model: "fake", effort: "low" },
  cost: { meteredUsd, subscriptionUsd: 0 },
});

test("groups threads under their project in feed order", () => {
  const projects = [
    { projectId: "a" as ProjectId, path: "C:/Users/a b/one" },
    { projectId: "b" as ProjectId, path: "/home/b/two" },
  ];
  const out = threadList(projects, [summary("t1", "b", "fix tests", true, 0.5), summary("t2", "a", ""), summary("t3", "b", "add feed")]);
  expect(out).toBe(
    [
      "/home/b/two",
      "  t1  busy  2026-09-30 09:15  fix tests  [$0.50 paid]",
      "  t3  idle  2026-09-30 09:15  add feed",
      "",
      "C:/Users/a b/one",
      "  t2  idle  2026-09-30 09:15  (no turns yet)",
      "",
    ].join("\n"),
  );
});

test("marks an archived thread", () => {
  const out = threadList([{ projectId: "a" as ProjectId, path: "/repo" }], [{ ...summary("t1", "a", "old work"), archived: true }]);
  expect(out).toContain("  t1  archived  2026-09-30 09:15  old work");
});

/** Runs `f` with this process in time zone `zone`, as on a machine set to it (tests run in UTC). */
const inZone = <A>(zone: string, f: () => A) => {
  const was = process.env.TZ;
  process.env.TZ = zone;
  try {
    return f();
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
};

test.each([
  ["Asia/Kolkata", "2026-09-30T22:30:42.000Z", "2026-10-01 04:00"],
  ["America/New_York", "2026-09-30T02:05:59.000Z", "2026-09-29 22:05"],
])("--list and search show times in the machine's zone, %s", (zone, at, local) => {
  const hit: SessionHit = {
    threadId: "t1" as ThreadId,
    turnId: "u1" as TurnId,
    projectId: "a" as ProjectId,
    projectPath: "/repo",
    title: "fix tests",
    archived: false,
    kind: "user",
    at,
    parts: [{ text: "flaky", match: true }],
  };
  const [list, search] = inZone(zone, () => [
    threadList([{ projectId: "a" as ProjectId, path: "/repo" }], [{ ...summary("t1", "a", "fix tests"), lastActivityAt: at }]),
    hitsText("flaky", [hit]),
  ]);
  expect(list).toContain(`  t1  idle  ${local}  fix tests`);
  expect(search).toStartWith(`${local}  fix tests  /repo\n`);
});
