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
import { injectionItem, nextWorktree } from "@verdandi/contracts";

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

const setReverted = (thread: LiveThread, turnIds: readonly TurnId[], reverted: boolean) => ({
  ...thread,
  turns: thread.turns.map((t) => (turnIds.includes(t.turnId) ? { ...t, reverted } : t)),
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
    tasks: [...thread.tasks, { taskId: e.taskId, rating: null }],
  }),
  "task.rated": (thread, e) => ({
    ...thread,
    tasks: thread.tasks.map((t) => (t.taskId === e.taskId ? { ...t, rating: e.rating } : t)),
  }),
  // A pick pins the route and ends the task; unpinning ends it too, so the next turn starts a routed one.
  "thread.route.unpinned": (thread) => ({ ...thread, pinned: false, task: null }),
  "routing.memory.cleared": (thread) => thread, // applies to the project's next routed task
  "thread.archived": (thread) => ({ ...thread, archived: true }),
  "thread.unarchived": (thread) => ({ ...thread, archived: false }),
  // Ends a routed thread's task, so the next turn is routed under the new mode.
  "thread.budget.changed": (thread, e) => ({ ...thread, budgetMode: e.mode, task: thread.pinned ? thread.task : null }),
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
    revert: null,
    turns: [
      ...thread.turns,
      {
        turnId: e.turnId,
        text: e.text,
        mode: e.mode ?? "build",
        attachments: e.attachments ?? [],
        status: "running",
        reverted: false,
        items: [],
        usage: [],
        streaming: "",
      },
    ],
  }),
  "harness.session.bound": (thread, e) => ({ ...thread, sessionId: e.sessionId }),
  "turn.item.added": (thread, e) => addItem(thread, e.turnId, e.item),
  "turn.steered": (thread, e) => addItem(thread, e.turnId, { kind: "user.steer", text: e.text }),
  "turn.model.called": (thread) => thread, // counts toward the task's maxTurns
  "turn.usage.recorded": (thread, { turnId, model, accessMode, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }) =>
    updateTurn(thread, turnId, (t) => ({
      ...t,
      usage: [...t.usage, { model, accessMode, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd }],
    })),
  "harness.quota.reported": (thread) => thread, // shown in the sidebar, from the projects feed
  "decision.recorded": (thread) => thread, // logged for the lab; the route shows through task.started
  "approval.requested": addRequest,
  "user-input.requested": addRequest,
  "skill.proposed": addRequest,
  // The skill is on disk, where the Skills tab reads it; a proposal that couldn't be written says why on its turn.
  "skill.applied": (thread, e) =>
    e.error !== undefined && e.turnId
      ? addItem(thread, e.turnId, { kind: "notice", text: `The skill change wasn't written: ${e.error}` })
      : thread,
  // Shown in the Skills tab, fetched when opened.
  "skill.reverted": (thread) => thread,
  "skill.pinned": (thread) => thread,
  "skill.unpinned": (thread) => thread,
  // A hub install waits on the Skills hub thread like any request, with no turn; its outcome shows in the Skills tab.
  "skill.install.proposed": addRequest,
  "skill.install.resolved": (thread, e) => ({
    ...thread,
    pendingRequests: thread.pendingRequests.filter((r) => r.requestId !== e.requestId),
  }),
  "skill.installed": (thread) => thread,
  "skill.uninstall.requested": (thread) => thread, // on the profile's stream, never a thread's
  "skill.uninstalled": (thread) => thread,
  "device.paired": (thread) => thread, // on the profile's stream, never a thread's
  "device.revoked": (thread) => thread,
  "pairing.requested": (thread) => thread,
  "pairing.approved": (thread) => thread,
  "pairing.denied": (thread) => thread,
  "sender.revoked": (thread) => thread,
  "gateway.owner.changed": (thread) => thread,
  "channel.bound": (thread, e) => ({ ...thread, binding: e.binding }),
  "channel.unbound": (thread) => {
    const { binding: _, ...rest } = thread;
    return rest;
  },
  // The outbox shows on the thread only when a delivery is abandoned, as the notice the projector adds too.
  "delivery.requested": (thread) => thread,
  "delivery.attempted": (thread) => thread,
  "delivery.reported": (thread) => thread,
  "delivery.abandoned": (thread, e) =>
    addItem(thread, e.turnId, { kind: "notice", text: `Verdandi couldn't deliver this to the chat it's bound to: ${e.reason}` }),
  // A background review's proposal waits for the user like the agent's own requests; the review itself runs out of sight.
  "memory.proposed": addRequest,
  // Verdandi's own request to run the project's commands; trusted lists show on the projects page, fetched when opened.
  "commands.trust.requested": addRequest,
  "commands.trusted": (thread) => thread,
  "commands.trust.revoked": (thread) => thread,
  "review.requested": (thread) => thread,
  "review.started": (thread) => thread,
  "handoff.started": (thread) => thread,
  "compression.started": (thread) => thread,
  "plan.requested": (thread, e) =>
    addRequest(
      addItem(thread, e.turnId, {
        kind: "plan",
        requestId: e.requestId,
        text: e.plan,
        ...(e.filePath === undefined ? {} : { filePath: e.filePath }),
      }),
      e,
    ),
  // An approved plan's build moves the rest of the task, and its reason becomes the task's.
  "task.rerouted": (thread, e) => ({
    ...addItem(thread, e.turnId, { kind: "route.switch", from: e.from, to: e.to, reason: e.decision.reason }),
    route: e.to,
    task: thread.task && { ...thread.task, source: e.decision.source, reason: e.decision.reason },
  }),
  // A provider's failure shows through the turn's error, or the fallback's route switch; the thread keeps its route.
  "provider.failed": (thread) => thread,
  "provider.recovered": (thread) => thread,
  "turn.rerouted": (thread, e) => addItem(thread, e.turnId, { kind: "route.switch", from: e.from, to: e.to, reason: e.reason }),
  "approvals.smart.changed": (thread) => thread, // the composer fetches it with ApprovalsGet
  "turn.effort.set": (thread, e) => addItem(thread, e.turnId, { kind: "effort", from: e.from, to: e.to, reason: e.reason }),
  "task.delegated": (thread, e) =>
    addItem(thread, e.turnId, { kind: "delegation", route: e.to, reason: e.decision.reason, parentToolUseId: e.toolUseId }),
  // A plan approved with the user's edit keeps both versions on its item.
  "approval.resolved": (thread, e) => {
    const edited = e.resolution.decision === "allow" ? e.resolution.plan : undefined;
    const answered = { ...thread, pendingRequests: thread.pendingRequests.filter((r) => r.requestId !== e.requestId) };
    if (edited === undefined) return answered;
    return updateTurn(answered, e.turnId, (t) => ({
      ...t,
      items: t.items.map((i) => (i.kind === "plan" && i.requestId === e.requestId ? { ...i, edited } : i)),
    }));
  },
  "turn.completed": (thread, e) => ({
    ...updateTurn(thread, e.turnId, (t) => ({
      ...t,
      status: e.status,
      streaming: "",
      ...(e.error === undefined ? {} : { error: e.error }),
    })),
    busy: false,
    // A budget guard's stop ends the task.
    ...(e.status === "limit" ? { task: null } : {}),
  }),
  "spend.cap.raised": (thread) => thread, // the caps are fetched with SpendCapsGet
  // The task goes on at `to` from its next turn: Verdandi's after a verifier, the user's after a correction, or within
  // this turn after a rejected plan.
  "task.escalated": (thread, { turnId, step, from, to, nextTurnId, requestId, reason }) => ({
    ...addItem(thread, turnId, {
      kind: "escalation",
      step,
      from,
      ...(to && { to }),
      ...(nextTurnId && { nextTurnId }),
      ...(requestId && { requestId }),
      reason,
    }),
    ...(to && { route: to, task: thread.task && { ...thread.task, reason } }),
  }),
  // The rest of the task moves to a cheaper model from the turn committed next, shown between the turns like a route change.
  "task.deescalated": (thread, e, at) => ({
    ...thread,
    route: e.to,
    task: thread.task && { ...thread.task, reason: e.decision.reason },
    routeChanges: [
      ...thread.routeChanges,
      { from: e.from, to: e.to, by: "router", reason: e.decision.reason, at, afterTurns: thread.turns.length },
    ],
  }),
  "thread.reverted": (thread, e) => ({
    ...setReverted(thread, e.turnIds, true),
    task: null,
    revert: { toTurnId: e.toTurnId, files: e.files, undone: false },
  }),
  "thread.revert.undone": (thread, e) => ({
    ...setReverted(thread, e.turnIds, false),
    revert: thread.revert && { ...thread.revert, undone: true },
  }),
  // Memory shows in its panel, fetched when opened.
  "memory.saved": (thread) => thread,
  "memory.edited": (thread) => thread,
  "memory.deleted": (thread) => thread,
  "memory.snapshot.taken": (thread) => thread,
  "skill.state.changed": (thread) => thread, // skills show in their panel, fetched when opened
  "task.blocked": (thread, e) => addItem(thread, e.turnId, { kind: "blocked", reason: e.reason }),
  "task.error.repeated": (thread) => thread, // the turn's `escalation` item names the trigger
  "injection.flagged": (thread, e) => addItem(thread, e.turnId, injectionItem(e)),
  "thread.files.restored": (thread, e) => ({
    ...thread,
    revert: thread.revert && {
      ...thread.revert,
      ...(e.error ? { filesError: e.error } : {}),
      ...(e.whole && { whole: true }),
      ...(e.outside.length > 0 && { outside: e.outside }),
    },
  }),
  "thread.checkpoints.removed": (thread) => thread,
  "thread.worktree.requested": (thread, e) => ({ ...thread, worktree: nextWorktree(thread.worktree, e) }),
  "thread.worktree.created": (thread, e) => ({ ...thread, worktree: nextWorktree(thread.worktree, e) }),
  "thread.worktree.failed": (thread, e) => ({ ...thread, worktree: nextWorktree(thread.worktree, e) }),
  "thread.worktree.setup.ran": (thread, e) => ({ ...thread, worktree: nextWorktree(thread.worktree, e) }),
  "thread.worktree.setup.held": (thread, e) => ({ ...thread, worktree: nextWorktree(thread.worktree, e) }),
  "thread.worktree.removal.requested": (thread, e) => ({ ...thread, worktree: nextWorktree(thread.worktree, e) }),
  "thread.worktree.removed": (thread, e) => ({ ...thread, worktree: nextWorktree(thread.worktree, e) }),
  "verifiers.started": (thread) => thread, // only closes the turn to steers, which the server refuses
  "verifier.ran": (thread, { type: _, v: _v, threadId: _t, turnId, ...run }) => addItem(thread, turnId, { kind: "verifier", ...run }),
};

/** Folds one thread-feed message into the thread. Before the snapshot arrives there is nothing to fold into. */
export const applyThreadFeed = (thread: LiveThread | undefined, feed: ThreadFeed): LiveThread | undefined => {
  if (feed.kind === "snapshot") return { ...feed.thread, turns: feed.thread.turns.map((t) => ({ ...t, streaming: "" })), seq: feed.seq };
  if (!thread) return thread;
  // Only a running turn streams: a feed that resubscribes as a turn completes can get a last delta after a snapshot that ended it.
  if (feed.kind === "delta")
    return updateTurn(thread, feed.turnId, (t) => (t.status === "running" ? { ...t, streaming: t.streaming + feed.text } : t));
  const { seq, event, at } = feed.stored;
  if (seq <= thread.seq) return thread;
  return { ...(apply[event.type] as Apply<Event["type"]>)(thread, event, at), seq };
};

/** The sidebar's data: threads most recently active first, and each harness's subscription window. */
export type Sidebar = {
  readonly projects: readonly ProjectSummary[];
  readonly threads: readonly ThreadSummary[];
  readonly quotas: readonly QuotaView[];
  /** Where a thread without a project runs. */
  readonly workspace: string;
};

/** `archived`: whether the sidebar shows archived threads; when it doesn't, a thread that gets archived leaves it. */
export const applyProjectsFeed = (sidebar: Sidebar | undefined, feed: ProjectsFeed, archived = false): Sidebar | undefined => {
  if (feed.kind === "snapshot") return { projects: feed.projects, threads: feed.threads, quotas: feed.quotas, workspace: feed.workspace };
  if (!sidebar) return sidebar;
  if (feed.kind === "quota") return { ...sidebar, quotas: [...sidebar.quotas.filter((q) => q.harness !== feed.quota.harness), feed.quota] };
  const { project, thread } = feed;
  const projects =
    project && !sidebar.projects.some((p) => p.projectId === project.projectId) ? [...sidebar.projects, project] : sidebar.projects;
  // ISO timestamps sort as strings. The sort is stable, so the changed thread leads its ties.
  const others = sidebar.threads.filter((t) => t.threadId !== thread.threadId);
  const threads = (thread.archived && !archived ? others : [thread, ...others]).sort(
    (a, b) => Number(b.lastActivityAt > a.lastActivityAt) - Number(b.lastActivityAt < a.lastActivityAt),
  );
  return { ...sidebar, projects, threads };
};

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * The sidebar's sections, by each thread's last activity in local time: Today, Yesterday, Previous 7 days,
 * Previous 30 days, then one per month. `threads` come newest first, and so do the sections.
 */
export const groupByRecency = (threads: readonly ThreadSummary[], now: Date) => {
  const today = startOfDay(now);
  const label = (iso: string) => {
    const at = new Date(iso);
    // Rounded, since a day across a daylight-saving change is 23 or 25 hours long.
    const days = Math.round((today - startOfDay(at)) / 86_400_000);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return "Previous 7 days";
    if (days < 30) return "Previous 30 days";
    return at.toLocaleDateString([], at.getFullYear() === now.getFullYear() ? { month: "long" } : { month: "long", year: "numeric" });
  };
  return [...Map.groupBy(threads, (t) => label(t.lastActivityAt))].map(([label, threads]) => ({ label, threads }));
};

/**
 * The right panel, on its Diff, Terminal, Memory or Skills tab. The diff is what `turnId` changed, or with `all` everything since
 * the thread's first turn. `turnId` is kept while `all` is on, so switching back shows the same turn. Each fetch
 * has its own `request`, and a result for any other request is dropped, so a slow answer never
 * replaces a newer one. Opened on another tab, no diff is fetched (`request` is empty) until the Diff tab is chosen.
 */
/** The panel's tabs that fetch nothing when opened: they load their own content. */
export type Shelf = "terminal" | "memory" | "skills";

export type Panel =
  | { readonly open: false }
  | {
      readonly open: true;
      readonly tab: "diff" | Shelf;
      readonly turnId: TurnId | undefined;
      readonly all: boolean;
      readonly request: string;
      readonly result: { readonly ok: true; readonly view: DiffView } | { readonly ok: false; readonly message: string } | undefined;
    };
export type OpenPanel = Extract<Panel, { open: true }>;

export type PanelAction =
  | { readonly type: "fetch"; readonly turnId: TurnId | undefined; readonly all: boolean; readonly request: string }
  | { readonly type: "result"; readonly request: string; readonly result: NonNullable<OpenPanel["result"]> }
  | { readonly type: "tab"; readonly tab: Shelf }
  | { readonly type: "close" };

export const closedPanel: Panel = { open: false };

export const applyPanel = (panel: Panel, action: PanelAction): Panel => {
  if (action.type === "close") return closedPanel;
  if (action.type === "tab")
    return panel.open
      ? { ...panel, tab: action.tab }
      : { open: true, tab: action.tab, turnId: undefined, all: true, request: "", result: undefined };
  if (action.type === "fetch")
    return {
      open: true,
      tab: "diff",
      turnId: action.turnId,
      all: action.all || action.turnId === undefined,
      request: action.request,
      result: undefined,
    };
  return panel.open && panel.request === action.request ? { ...panel, result: action.result } : panel;
};
