import { expect, test } from "bun:test";
import type { Event, ProjectId, StoredEvent, ThreadId, TurnId } from "@verdandi/contracts";
import { buildTrajectory } from "./build.ts";

const threadId = "t1" as ThreadId;
const turnId = "u1" as TurnId;
const sonnet = { harness: "claude-code", model: "claude-sonnet-5-5", effort: "high" } as const;
const usage = (accessMode: "subscription" | "metered") =>
  ({
    type: "turn.usage.recorded",
    v: 1,
    threadId,
    turnId,
    model: "m",
    accessMode,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  }) as const;
const stored = (events: Event[]): StoredEvent[] =>
  events.map((event, i) => ({ seq: i + 1, eventId: `e${i}`, commandId: `c${i}`, at: `2026-01-01T00:00:0${i}Z`, event }));

test("keeps the route the turn started on, and counts a partly metered turn as metered", () => {
  const events = stored([
    { type: "thread.created", v: 1, threadId, projectId: "p" as ProjectId, projectPath: "/repo", route: sonnet },
    { type: "harness.session.bound", v: 1, threadId, sessionId: "s1", harnessVersion: "2.1.284", transcriptPath: "/t/s1.jsonl" },
    { type: "turn.started", v: 2, threadId, turnId, text: "go" },
    { type: "thread.route.changed", v: 1, threadId, from: sonnet, to: { ...sonnet, model: "claude-opus-5-5" }, by: "user" },
    usage("subscription"),
    usage("metered"),
    { type: "turn.completed", v: 1, threadId, turnId, status: "success" },
  ]);
  const trajectory = buildTrajectory(events, turnId);
  expect(trajectory?.route).toEqual(sonnet);
  expect(trajectory?.mode).toBe("build");
  expect(trajectory?.provenance).toEqual({ provider: "anthropic", harnessVersion: "2.1.284", accessMode: "metered" });
  expect(trajectory?.transcript).toEqual({ sessionId: "s1", path: "/t/s1.jsonl" });
  expect(buildTrajectory(events.slice(0, -1), turnId)).toBeUndefined();
});
