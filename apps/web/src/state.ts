import type {
  DiffView,
  Event,
  Item,
  ProjectSummary,
  ProjectsFeed,
  QuotaView,
  ThreadFeed,
  ThreadSummary,
  ThreadView,
  TurnId,
  TurnView,
} from "@verdandi/contracts";

/** A turn as the UI shows it: the stored view plus the main agent's text streamed since its last message. */
export type LiveTurn = TurnView & { readonly streaming: string };
/** `seq` is the last event applied, so replayed events are skipped. */
export type LiveThread = Omit<ThreadView, "turns"> & { readonly turns: readonly LiveTurn[]; readonly seq: number };

const updateTurn = (thread: LiveThread, turnId: TurnId, f: (turn: LiveTurn) => LiveTurn): LiveThread => {
  const i = thread.turns.findLastIndex((t) => t.turnId === turnId);
  const turn = thread.turns[i];
  return turn ? { ...thread, turns: thread.turns.with(i, f(turn)) } : thread;
};
const addItem = (thread: LiveThread, turnId: TurnId, item: Item) =>
  updateTurn(thread, turnId, (t) => ({
    ...t,
    items: [...t.items, item],
    // The stored message replaces the text streamed for it. Subagent text is never streamed.
    streaming: item.kind === "assistant.message" && item.parentToolUseId === undefined ? "" : t.streaming,
  }));
const addRequest = (thread: LiveThread, request: ThreadView["pendingRequests"][number]) => ({
  ...thread,
  pendingRequests: [...thread.pendingRequests, request],
});

type Apply<T extends Event["type"]> = (thread: LiveThread, event: Extract<Event, { type: T }>, at: string) => LiveThread;

// Mirrors the server's projector, so a live thread matches the snapshot a reload would fetch.
const apply: { [T in Event["type"]]: Apply<T> } = {
  "thread.created": (thread) => thread,
  // The router may move the thread to another harness, whose session starts fresh.
  "task.started": (thread, e) => ({
    ...thread,
    route: e.route,
    sessionId: thread.route.harness === e.route.harness ? thread.sessionId : null,
    task: { taskId: e.taskId, ...(e.decision ? { source: e.decision.source, reason: e.decision.reason } : {}) },
  }),
  // A pick pins the route and ends the task; unpinning ends it too, so the next turn starts a routed one.
  "thread.route.unpinned": (thread) => ({ ...thread, pinned: false, task: null }),
  "thread.route.changed": (thread, e, at) => ({
    ...thread,
    route: e.to,
    pinned: true,
    task: null,
    // A session belongs to one harness: a new harness starts a fresh one.
    sessionId: e.from.harness === e.to.harness ? thread.sessionId : null,
    routeChanges: [...thread.routeChanges, { from: e.from, to: e.to, by: e.by, at, afterTurns: thread.turns.length }],
  }),
  "turn.started": (thread, e) => ({
    ...thread,
    busy: true,
    turns: [
      ...thread.turns,
      { turnId: e.turnId, text: e.text, mode: e.mode ?? "build", status: "running", items: [], usage: [], streaming: "" },
    ],
  }),
  "harness.session.bound": (thread, e) => ({ ...thread, sessionId: e.sessionId }),
  "turn.item.added": (thread, e) => addItem(thread, e.turnId, e.item),
  "turn.steered": (thread, e) => addItem(thread, e.turnId, { kind: "user.steer", text: e.text }),
  "turn.usage.recorded": (thread, { turnId, model, accessMode, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }) =>
    updateTurn(thread, turnId, (t) => ({
      ...t,
      usage: [...t.usage, { model, accessMode, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }],
    })),
  "harness.quota.reported": (thread) => thread, // shown in the sidebar, from the projects feed
  "approval.requested": addRequest,
  "user-input.requested": addRequest,
  "plan.requested": (thread, e) =>
    addRequest(addItem(thread, e.turnId, { kind: "plan", text: e.plan, ...(e.filePath === undefined ? {} : { filePath: e.filePath }) }), e),
  "approval.resolved": (thread, e) => ({ ...thread, pendingRequests: thread.pendingRequests.filter((r) => r.requestId !== e.requestId) }),
  "turn.completed": (thread, e) => ({
    ...updateTurn(thread, e.turnId, (t) => ({
      ...t,
      status: e.status,
      streaming: "",
      ...(e.error === undefined ? {} : { error: e.error }),
    })),
    busy: false,
  }),
};

/** Folds one thread-feed message into the thread. Before the snapshot arrives there is nothing to fold into. */
export const applyThreadFeed = (thread: LiveThread | undefined, feed: ThreadFeed): LiveThread | undefined => {
  if (feed.kind === "snapshot") return { ...feed.thread, turns: feed.thread.turns.map((t) => ({ ...t, streaming: "" })), seq: feed.seq };
  if (!thread) return thread;
  if (feed.kind === "delta") return updateTurn(thread, feed.turnId, (t) => ({ ...t, streaming: t.streaming + feed.text }));
  const { seq, event, at } = feed.stored;
  if (seq <= thread.seq) return thread;
  return { ...(apply[event.type] as Apply<Event["type"]>)(thread, event, at), seq };
};

/** The sidebar's data: threads most recently active first, and each harness's subscription window. */
export type Sidebar = {
  readonly projects: readonly ProjectSummary[];
  readonly threads: readonly ThreadSummary[];
  readonly quotas: readonly QuotaView[];
};

export const applyProjectsFeed = (sidebar: Sidebar | undefined, feed: ProjectsFeed): Sidebar | undefined => {
  if (feed.kind === "snapshot") return { projects: feed.projects, threads: feed.threads, quotas: feed.quotas };
  if (!sidebar) return sidebar;
  if (feed.kind === "quota") return { ...sidebar, quotas: [...sidebar.quotas.filter((q) => q.harness !== feed.quota.harness), feed.quota] };
  const { project, thread } = feed;
  const projects =
    project && !sidebar.projects.some((p) => p.projectId === project.projectId) ? [...sidebar.projects, project] : sidebar.projects;
  // ISO timestamps sort as strings. The sort is stable, so the changed thread leads its ties.
  const threads = [thread, ...sidebar.threads.filter((t) => t.threadId !== thread.threadId)].sort(
    (a, b) => Number(b.lastActivityAt > a.lastActivityAt) - Number(b.lastActivityAt < a.lastActivityAt),
  );
  return { ...sidebar, projects, threads };
};

/**
 * The right panel. Open, it shows a diff: the files `turnId` touched, or with `all` the whole project
 * against `HEAD`. `turnId` is kept while `all` is on, so switching back shows the same turn. Each fetch
 * has its own `request`, and a result for any other request is dropped, so a slow answer never
 * replaces a newer one.
 */
export type DiffPanel =
  | { readonly open: false }
  | {
      readonly open: true;
      readonly turnId: TurnId | undefined;
      readonly all: boolean;
      readonly request: string;
      readonly result: { readonly ok: true; readonly view: DiffView } | { readonly ok: false; readonly message: string } | undefined;
    };

export type DiffPanelAction =
  | { readonly type: "fetch"; readonly turnId: TurnId | undefined; readonly all: boolean; readonly request: string }
  | { readonly type: "result"; readonly request: string; readonly result: NonNullable<Extract<DiffPanel, { open: true }>["result"]> }
  | { readonly type: "close" };

export const closedPanel: DiffPanel = { open: false };

export const applyDiffPanel = (panel: DiffPanel, action: DiffPanelAction): DiffPanel => {
  if (action.type === "close") return closedPanel;
  if (action.type === "fetch")
    return {
      open: true,
      turnId: action.turnId,
      all: action.all || action.turnId === undefined,
      request: action.request,
      result: undefined,
    };
  return panel.open && panel.request === action.request ? { ...panel, result: action.result } : panel;
};
