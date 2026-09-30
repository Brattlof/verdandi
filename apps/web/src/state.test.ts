import { expect, test } from "bun:test";
import type {
  Event,
  ProjectId,
  ProjectsFeed,
  QuotaView,
  Route,
  TaskId,
  ThreadFeed,
  ThreadId,
  ThreadSummary,
  TurnId,
} from "@verdandi/contracts";
import { applyDiffPanel, applyProjectsFeed, applyThreadFeed, closedPanel, type DiffPanelAction, type LiveThread } from "./state.ts";

const threadId = "thread-1" as ThreadId;
const turnId = "turn-1" as TurnId;
const route = { harness: "fake", model: "fake", effort: "low" } as const;

const snapshot: ThreadFeed = {
  kind: "snapshot",
  seq: 1,
  thread: {
    threadId,
    projectPath: "C:/Users/a b/repo",
    route,
    pinned: true,
    archived: false,
    budgetMode: null,
    task: null,
    sessionId: null,
    busy: false,
    turns: [],
    routeChanges: [],
    pendingRequests: [],
  },
};
const event = (seq: number, e: Event): ThreadFeed => ({
  kind: "event",
  stored: { seq, eventId: `e${seq}`, commandId: `c${seq}`, at: "", event: e },
});
const fold = (feeds: ThreadFeed[]) => feeds.reduce<LiveThread | undefined>(applyThreadFeed, undefined);

test("a streamed turn: deltas show until the stored message replaces them, and completion ends it", () => {
  const started = fold([
    snapshot,
    event(2, { type: "turn.started", v: 2, threadId, turnId, text: "hi", mode: "plan" }),
    { kind: "delta", turnId, text: "echo: " },
    { kind: "delta", turnId, text: "hi" },
  ]);
  expect(started?.busy).toBe(true);
  expect(started?.turns[0]).toMatchObject({ text: "hi", mode: "plan", status: "running", streaming: "echo: hi" });

  const done = fold([
    snapshot,
    event(2, { type: "turn.started", v: 2, threadId, turnId, text: "hi", mode: "plan" }),
    { kind: "delta", turnId, text: "echo: hi" },
    event(3, { type: "turn.item.added", v: 1, threadId, turnId, item: { kind: "assistant.message", text: "echo: hi" } }),
    event(4, {
      type: "turn.usage.recorded",
      v: 1,
      threadId,
      turnId,
      model: "fake",
      accessMode: "subscription",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
    }),
    event(5, { type: "turn.completed", v: 1, threadId, turnId, status: "success" }),
  ]);
  expect(done?.busy).toBe(false);
  expect(done?.seq).toBe(5);
  expect(done?.turns[0]).toMatchObject({
    status: "success",
    streaming: "",
    items: [{ kind: "assistant.message", text: "echo: hi" }],
    usage: [{ model: "fake", inputTokens: 10, outputTokens: 5, costUsd: 0.01 }],
  });
});

test("a route change lands after the turns so far, and a new harness drops the session", () => {
  const at = "2026-09-30T10:00:00.000Z";
  const to = { ...route, harness: "claude-code", model: "sonnet" } as const;
  const thread = fold([
    { ...snapshot, thread: { ...snapshot.thread, sessionId: "s1" } },
    event(2, { type: "turn.started", v: 2, threadId, turnId, text: "hi" }),
    {
      kind: "event",
      stored: {
        seq: 3,
        eventId: "e3",
        commandId: "c3",
        at,
        event: { type: "thread.route.changed", v: 1, threadId, from: route, to, by: "user" },
      },
    },
  ]);
  expect(thread?.route).toEqual(to);
  expect(thread?.sessionId).toBeNull();
  expect(thread?.routeChanges).toEqual([{ from: route, to, by: "user", at, afterTurns: 1 }]);
});

test("events the snapshot already includes are skipped", () => {
  const thread = fold([{ ...snapshot, seq: 3 }, event(3, { type: "turn.started", v: 2, threadId, turnId, text: "replayed" })]);
  expect(thread?.turns).toEqual([]);
});

test("a plan waits as a pending request and leaves a plan item once answered", () => {
  const feeds = [
    snapshot,
    event(2, { type: "turn.started", v: 2, threadId, turnId, text: "plan" }),
    event(3, { type: "plan.requested", v: 1, threadId, turnId, requestId: "r1", plan: "1. Edit a.txt" }),
  ];
  expect(fold(feeds)?.pendingRequests.map((r) => r.requestId)).toEqual(["r1"]);
  const answered = fold([
    ...feeds,
    event(4, { type: "approval.resolved", v: 1, threadId, turnId, requestId: "r1", resolution: { decision: "allow" } }),
  ]);
  expect(answered?.pendingRequests).toEqual([]);
  expect(answered?.turns[0]?.items).toEqual([{ kind: "plan", text: "1. Edit a.txt" }]);
});

test("the projects feed adds new threads on top and moves a changed thread up", () => {
  const projectId = "p1" as ProjectId;
  const summary = (id: string, lastActivityAt: string, busy = false): ThreadSummary => ({
    threadId: id as ThreadId,
    projectId,
    title: id,
    busy,
    archived: false,
    lastActivityAt,
    route,
    cost: { meteredUsd: 0, subscriptionUsd: 0 },
  });
  let sidebar = applyProjectsFeed(undefined, {
    kind: "snapshot",
    projects: [{ projectId, path: "/repo" }],
    threads: [summary("b", "2026-09-30T10:00:00.000Z"), summary("a", "2026-09-30T09:00:00.000Z")],
    quotas: [],
    seq: 5,
  });
  sidebar = applyProjectsFeed(sidebar, { kind: "thread", thread: summary("a", "2026-09-30T11:00:00.000Z", true), seq: 6 });
  expect(sidebar?.threads.map((t) => [t.threadId as string, t.busy])).toEqual([
    ["a", true],
    ["b", false],
  ]);
  const other = "p2" as ProjectId;
  sidebar = applyProjectsFeed(sidebar, {
    kind: "thread",
    thread: { ...summary("c", "2026-09-30T12:00:00.000Z"), projectId: other },
    project: { projectId: other, path: "/other" },
    seq: 7,
  });
  expect(sidebar?.threads.map((t) => t.threadId as string)).toEqual(["c", "a", "b"]);
  expect(sidebar?.projects.map((p) => p.path)).toEqual(["/repo", "/other"]);

  const archived = { kind: "thread", thread: { ...summary("a", "2026-09-30T13:00:00.000Z"), archived: true }, seq: 8 } as const;
  expect(applyProjectsFeed(sidebar, archived)?.threads.map((t) => t.threadId as string)).toEqual(["c", "b"]);
  expect(applyProjectsFeed(sidebar, archived, true)?.threads.map((t) => [t.threadId as string, t.archived])).toEqual([
    ["a", true],
    ["c", false],
    ["b", false],
  ]);
});

test("a harness's new quota replaces its old one and keeps the threads", () => {
  const quota = (status: QuotaView["quota"]["status"], usingOverage: boolean, seq: number): ProjectsFeed => ({
    kind: "quota",
    quota: { harness: "claude-code", quota: { status, usingOverage }, at: "2026-09-30T12:00:00.000Z" },
    seq,
  });
  let sidebar = applyProjectsFeed(undefined, { kind: "snapshot", projects: [], threads: [], quotas: [], seq: 1 });
  sidebar = applyProjectsFeed(sidebar, quota("allowed_warning", false, 2));
  sidebar = applyProjectsFeed(sidebar, quota("rejected", true, 3));
  expect(sidebar?.quotas.map((q) => [q.harness, q.quota.status, q.quota.usingOverage])).toEqual([["claude-code", "rejected", true]]);
});

test("the diff panel shows the latest fetch's result, drops stale ones, and closes", () => {
  const view = { files: [{ path: "a.txt", diff: "+x\n", truncated: false }], omittedFiles: 0 };
  const panel = (actions: DiffPanelAction[]) => actions.reduce(applyDiffPanel, closedPanel);

  const turn = panel([
    { type: "fetch", turnId, all: false, request: "r1" },
    { type: "result", request: "r1", result: { ok: true, view } },
  ]);
  expect(turn).toMatchObject({ open: true, turnId, all: false, result: { ok: true, view } });

  // Switching to the whole project while the turn's diff is in flight: the turn's answer is dropped.
  const switched = panel([
    { type: "fetch", turnId, all: false, request: "r1" },
    { type: "fetch", turnId, all: true, request: "r2" },
    { type: "result", request: "r1", result: { ok: true, view } },
  ]);
  expect(switched).toMatchObject({ open: true, turnId, all: true, result: undefined });

  const failed = applyDiffPanel(switched, { type: "result", request: "r2", result: { ok: false, message: "Run git init." } });
  expect(failed).toMatchObject({ all: true, result: { ok: false, message: "Run git init." } });

  // Without a turn there is only the whole project; a result after closing is dropped.
  expect(panel([{ type: "fetch", turnId: undefined, all: false, request: "r3" }])).toMatchObject({ all: true });
  expect(
    panel([
      { type: "fetch", turnId, all: false, request: "r4" },
      { type: "close" },
      { type: "result", request: "r4", result: { ok: true, view } },
    ]),
  ).toEqual(closedPanel);
});

test("a routed task moves the thread to its route with its reason; a pick pins it, and unpinning hands it back", () => {
  const taskId = turnId as string as TaskId;
  const routed: Route = { harness: "fake", model: "fake-small", effort: "low" };
  const auto = { ...snapshot, thread: { ...snapshot.thread, pinned: false, sessionId: "s1" } };
  const decision = {
    source: "policy",
    taskClass: "ask.search",
    difficulty: 0.1,
    confidence: 0.7,
    target: { harness: "fake", provider: "fake", model: "fake-small", access: "local" },
    effort: "low",
    reason: "Looks like ask.search, so it runs on fake-small at low effort.",
    trace: [],
  } as const;
  const started = fold([auto, event(2, { type: "task.started", v: 2, threadId, taskId, route: routed, decision })]);
  expect(started).toMatchObject({
    route: routed,
    pinned: false,
    sessionId: "s1",
    task: { taskId, source: "policy", reason: decision.reason },
  });

  const picked = applyThreadFeed(started, event(3, { type: "thread.route.changed", v: 1, threadId, from: routed, to: routed, by: "user" }));
  expect(picked).toMatchObject({ pinned: true, task: null });
  expect(applyThreadFeed(picked, event(4, { type: "thread.route.unpinned", v: 1, threadId }))).toMatchObject({ pinned: false, task: null });
});

test("a budget mode change ends a routed thread's task but keeps a pinned one's, matching the projector", () => {
  const taskId = turnId as string as TaskId;
  const task = event(2, { type: "task.started", v: 2, threadId, taskId, route });
  const budget = event(3, { type: "thread.budget.changed", v: 1, threadId, mode: "max" });
  const routed = fold([{ ...snapshot, thread: { ...snapshot.thread, pinned: false } }, task, budget]);
  expect(routed).toMatchObject({ budgetMode: "max", task: null });
  expect(fold([snapshot, task, budget])).toMatchObject({ budgetMode: "max", task: { taskId } });
});
