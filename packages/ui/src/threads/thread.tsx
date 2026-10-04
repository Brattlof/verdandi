import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type CommandId,
  clip,
  codePointStart,
  describeCompression,
  describeRevertFiles,
  describeRouteChange,
  type InteractionMode,
  type Item,
  injectionLead,
  type TaskId,
  type TaskRating,
  type ThreadId,
  type TurnId,
  type TurnView,
} from "@verdandi/contracts";
import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { type Connection, createStore, useStore, uuid } from "../client.ts";
import { TurnAttachments } from "../composer/attachments.tsx";
import { Composer, Requests } from "../composer/composer.tsx";
import { SidePanel, TextDiff } from "../diffs/diff.tsx";
import { RouteMarkers } from "../routing/route.tsx";
import { applyPanel, applyThreadFeed, closedPanel, type LiveThread, type LiveTurn } from "../state.ts";
import { Longship } from "../ui/art.tsx";
import { ChevronIcon, ThumbDownIcon, ThumbUpIcon } from "../ui/icons.tsx";
import { Markdown } from "../ui/markdown.tsx";
import { Rune } from "../ui/runes.tsx";
import { WorktreeBar } from "../worktrees/worktree.tsx";
import { ArchiveButton } from "./archive.tsx";

/** The header's quiet buttons: words with an icon, on the sky surface while their panel is open. */
const headerButton =
  "border-transparent bg-transparent px-2 text-xs text-muted hover:text-fg aria-pressed:bg-user aria-pressed:text-accent";

export const ThreadPane = ({
  connection,
  threadId,
  focusTurn,
}: {
  connection: Connection;
  threadId: ThreadId;
  /** A turn to scroll to, e.g. a search result's. */
  focusTurn: TurnId | null;
}) => {
  const [store] = useState(() => createStore<LiveThread | undefined>(undefined));
  const [error, setError] = useState<string>();
  const [archiveError, setArchiveError] = useState<string>();
  useEffect(
    () =>
      connection.follow(
        (rpc, subscriptionId) => rpc.ThreadSubscribe({ threadId, subscriptionId }),
        (feed) => store.set(applyThreadFeed(store.get(), feed)),
        setError,
      ),
    [connection, threadId, store],
  );
  const thread = useStore(store);
  // Chosen per turn, like `verdandi chat`: the thread's last mode, until the user picks another.
  const [mode, setMode] = useState<InteractionMode>();
  const [panel, setPanel] = useReducer(applyPanel, closedPanel);
  // Diffs are fetched only when asked for: opening the panel, switching what it shows, or Refresh.
  const fetchDiff = useCallback(
    (turnId: TurnId | undefined, all: boolean) => {
      const request = uuid();
      setPanel({ type: "fetch", turnId, all, request });
      void connection.diff(threadId, all ? undefined : turnId).then((result) => setPanel({ type: "result", request, result }));
    },
    [connection, threadId],
  );
  const showTurnDiff = useCallback((turnId: TurnId) => fetchDiff(turnId, false), [fetchDiff]);
  const [revertError, setRevertError] = useState<string>();
  const revert = useCallback(
    (toTurnId: TurnId, files: boolean) =>
      void connection
        .dispatch({ type: "thread.revert", commandId: uuid<CommandId>(), threadId, toTurnId, files })
        .then((r) => setRevertError(r.ok ? undefined : r.message)),
    [connection, threadId],
  );
  const [rateError, setRateError] = useState<string>();
  const rate = useCallback(
    (taskId: TaskId, rating: TaskRating | null) =>
      void connection
        .dispatch({ type: "task.rate", commandId: uuid<CommandId>(), threadId, taskId, rating })
        .then((r) => setRateError(r.ok ? undefined : r.message)),
    [connection, threadId],
  );
  if (error)
    return (
      <p role="alert" className="p-6 text-error">
        {error}
      </p>
    );
  if (!thread) return null;
  const last = thread.turns.at(-1);
  const lastFinished = thread.turns.findLast((t) => t.status !== "running");
  const turnIndex = panel.open ? thread.turns.findIndex((t) => t.turnId === panel.turnId) : -1;
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-4 py-2">
          <div className="min-w-0 flex-1 basis-60">
            <h1 className="truncate font-serif text-xl leading-tight font-semibold">
              {thread.turns[0]?.text.split("\n", 1)[0] || "New thread"}
            </h1>
            <p title={thread.worktree?.path ?? thread.projectPath} className="truncate font-mono text-xs text-muted">
              {thread.projectPath}
              {thread.worktree && <span> · worktree on {thread.worktree.branch}</span>}
            </p>
          </div>
          <span className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              className={headerButton}
              aria-pressed={panel.open && panel.tab === "diff"}
              onClick={() => (panel.open && panel.tab === "diff" ? setPanel({ type: "close" }) : fetchDiff(lastFinished?.turnId, true))}
            >
              <Rune name="eihwaz" className="size-3.5" />
              Diff
            </button>
            <button
              type="button"
              className={headerButton}
              aria-pressed={panel.open && panel.tab === "terminal"}
              onClick={() => setPanel(panel.open && panel.tab === "terminal" ? { type: "close" } : { type: "tab", tab: "terminal" })}
            >
              <Rune name="thurisaz" className="size-3.5" />
              Terminal
            </button>
            <button
              type="button"
              className={headerButton}
              aria-pressed={panel.open && panel.tab === "memory"}
              onClick={() => setPanel(panel.open && panel.tab === "memory" ? { type: "close" } : { type: "tab", tab: "memory" })}
            >
              <Rune name="mannaz" className="size-3.5" />
              Memory
            </button>
            <button
              type="button"
              className={headerButton}
              aria-pressed={panel.open && panel.tab === "skills"}
              onClick={() => setPanel(panel.open && panel.tab === "skills" ? { type: "close" } : { type: "tab", tab: "skills" })}
            >
              <Rune name="ansuz" className="size-3.5" />
              Skills
            </button>
            {!thread.busy && (
              <ArchiveButton
                connection={connection}
                threadId={threadId}
                archived={thread.archived}
                className={headerButton}
                onError={setArchiveError}
              />
            )}
          </span>
        </header>
        {thread.worktree && <WorktreeBar connection={connection} threadId={threadId} worktree={thread.worktree} busy={thread.busy} />}
        {(thread.archived || archiveError) && (
          <p role="status" className={`border-b border-line bg-panel px-4 py-1.5 text-xs ${archiveError ? "text-error" : "text-muted"}`}>
            {archiveError ?? "This thread is archived: it's hidden from the thread list and takes no turns until you unarchive it."}
          </p>
        )}
        {rateError && (
          <p role="alert" className="border-b border-line bg-panel px-4 py-1.5 text-xs text-error">
            {rateError}
          </p>
        )}
        {(thread.revert || revertError) && (
          <RevertBar connection={connection} threadId={threadId} thread={thread} error={revertError} onError={setRevertError} />
        )}
        <Conversation
          connection={connection}
          turns={thread.turns}
          tasks={thread.tasks}
          routeChanges={thread.routeChanges}
          busy={thread.busy}
          focus={focusTurn}
          onChanges={showTurnDiff}
          onRevert={revert}
          onRate={rate}
        />
        <Requests connection={connection} threadId={threadId} requests={thread.pendingRequests} onPlanApproved={() => setMode("build")} />
        <Composer connection={connection} thread={thread} mode={mode ?? last?.mode ?? "build"} onMode={setMode} />
        <div role="status" className="sr-only">
          {thread.pendingRequests.length > 0
            ? "The agent is waiting for your answer."
            : last && last.status !== "running"
              ? `Turn ${statusText[last.status].toLowerCase()}.`
              : ""}
        </div>
      </div>
      {panel.open && (
        <SidePanel
          connection={connection}
          threadId={threadId}
          panel={panel}
          turnLabel={turnIndex >= 0 ? `Turn ${turnIndex + 1}` : undefined}
          onFetch={fetchDiff}
          onTab={(tab) => setPanel({ type: "tab", tab })}
          onClose={() => setPanel({ type: "close" })}
        />
      )}
    </div>
  );
};

/**
 * Only the turns in view are rendered. The list follows new output while scrolled to the bottom.
 * Route changes show above the turn that followed them, or after the last turn.
 */
const Conversation = ({
  connection,
  turns,
  tasks,
  routeChanges,
  busy,
  focus,
  onChanges,
  onRevert,
  onRate,
}: {
  connection: Connection;
  turns: readonly LiveTurn[];
  tasks: LiveThread["tasks"];
  routeChanges: LiveThread["routeChanges"];
  busy: boolean;
  focus: TurnId | null;
  onChanges: (turnId: TurnId) => void;
  onRevert: (turnId: TurnId, files: boolean) => void;
  onRate: (taskId: TaskId, rating: TaskRating | null) => void;
}) => {
  // Any shown turn but the latest can be reverted to, while no turn runs.
  const lastShown = turns.findLast((t) => !t.reverted)?.turnId;
  const scroller = useRef<HTMLElement>(null);
  const atBottom = useRef(true);
  const changesBefore = useMemo(() => Map.groupBy(routeChanges, (c) => c.afterTurns), [routeChanges]);
  // Turns Verdandi sent itself, escalating a task whose verifier failed.
  const escalations = useMemo(
    () => new Set(turns.flatMap((t) => t.items.flatMap((i) => (i.kind === "escalation" && i.nextTurnId ? [i.nextTurnId] : [])))),
    [turns],
  );
  // A task starts with the turn its id names; its rating sits under its last turn, before the next task's first.
  const rateAt = useMemo(() => {
    const starts = new Map<string, Task>(tasks.map((t) => [t.taskId, t]));
    const at = new Map<TurnId, Task>();
    let task: Task | undefined;
    turns.forEach((turn, i) => {
      task = starts.get(turn.turnId) ?? task;
      const next = turns[i + 1];
      if (task && (!next || starts.has(next.turnId))) at.set(turn.turnId, task);
    });
    return at;
  }, [turns, tasks]);
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 160,
    overscan: 4,
    getItemKey: (i) => turns[i]?.turnId ?? i,
  });
  // A turn to show, e.g. a search result's: scrolled to once, as soon as it's loaded.
  const focused = useRef<TurnId | null>(null);
  const focusIndex = focus ? turns.findIndex((t) => t.turnId === focus) : -1;
  useEffect(() => {
    if (focusIndex < 0 || focused.current === focus) return;
    focused.current = focus;
    atBottom.current = false;
    virtualizer.scrollToIndex(focusIndex, { align: "start" });
  }, [focus, focusIndex, virtualizer]);
  // Runs after every render, including the virtualizer's own after it measures a turn.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <section
      ref={scroller}
      // No scroll anchoring: the virtualizer keeps the scroll position itself.
      className="flex-1 overflow-y-auto [overflow-anchor:none]"
      aria-label="Conversation"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable to scroll it with the keyboard.
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      }}
    >
      {turns.length === 0 && (
        <div className="mx-auto max-w-[860px] px-4 pt-16 text-center">
          <Longship className="mx-auto mb-4 size-20 text-line-strong" />
          <h2 className="font-serif text-3xl font-semibold">Start the conversation</h2>
          <p className="mt-2 font-serif text-lg">Every thread is spun one turn at a time.</p>
          <p className="mt-1 text-muted">
            Ask a question, plan a change or build it. Unless you pin a route, the router picks one when you send.
          </p>
        </div>
      )}
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((row) => {
          const turn = turns[row.index];
          return (
            turn && (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <RouteMarkers changes={changesBefore.get(row.index)} />
                <Turn
                  connection={connection}
                  turn={turn}
                  byVerdandi={escalations.has(turn.turnId)}
                  revertable={!busy && !turn.reverted && turn.turnId !== lastShown}
                  task={rateAt.get(turn.turnId)}
                  onChanges={onChanges}
                  onRevert={onRevert}
                  onRate={onRate}
                />
              </div>
            )
          );
        })}
      </div>
      <RouteMarkers changes={changesBefore.get(turns.length)} />
    </section>
  );
};

const statusText: Record<LiveTurn["status"], string> = {
  running: "Working",
  success: "Done",
  error: "Failed",
  interrupted: "Stopped",
  limit: "Limit reached",
};
/** Text colour, then the dot beside it; the status is always spelled out too. */
const statusColor: Record<LiveTurn["status"], readonly [string, string]> = {
  running: ["text-accent", "bg-accent"],
  success: ["text-ok", "bg-ok"],
  error: ["text-error", "bg-error"],
  interrupted: ["text-warn", "bg-warn"],
  limit: ["text-warn", "bg-warn"],
};

/** The user's words sit on the right, the agent's work runs full width beneath. */
const UserBubble = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="my-2 ml-auto w-fit max-w-[85%] rounded-md bg-user px-4 py-2.5">
    <span className="eyebrow block text-muted">{label}</span>
    {children}
  </div>
);

type Task = LiveThread["tasks"][number];

type TurnProps = {
  connection: Connection;
  turn: LiveTurn;
  byVerdandi: boolean;
  revertable: boolean;
  /** The task this turn ends, which the user can rate once it's done. */
  task: Task | undefined;
  onChanges: (turnId: TurnId) => void;
  onRevert: (turnId: TurnId, files: boolean) => void;
  onRate: (taskId: TaskId, rating: TaskRating | null) => void;
};

const Turn = memo((props: TurnProps) => {
  const { connection, turn, byVerdandi } = props;
  const body = (
    <>
      <UserBubble label={byVerdandi ? "Verdandi, escalating" : `You${turn.mode === "build" ? "" : ` · ${turn.mode}`}`}>
        <p className="mt-0.5 mb-0">{turn.text}</p>
        <TurnAttachments connection={connection} attachments={turn.attachments} />
      </UserBubble>
      <Items items={turn.items} />
      {turn.streaming && (
        <div>
          <Markdown text={turn.streaming} />
        </div>
      )}
      <TurnStatus {...props} />
    </>
  );
  // A reverted turn stays in the log, folded away and out of the conversation.
  return turn.reverted ? (
    <details className="turn mx-auto max-w-[860px] px-4 py-1 text-muted">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs [&::-webkit-details-marker]:hidden">
        <ChevronIcon className="size-3.5 [details[open]>summary>&]:rotate-90" />
        <span className="shrink-0 font-medium">Reverted</span>
        <span className="min-w-0 truncate">{turn.text.split("\n", 1)[0]}</span>
      </summary>
      <div className="opacity-70">{body}</div>
    </details>
  ) : (
    <article className="turn mx-auto max-w-[860px] px-4 py-3">{body}</article>
  );
});

const TurnStatus = ({ turn, revertable, task, onChanges, onRevert, onRate }: TurnProps) => {
  const [text, dot] = statusColor[turn.status];
  const [reverting, setReverting] = useState(false);
  return (
    <footer className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2 text-xs text-muted">
      <span className={`eyebrow flex items-center gap-1.5 ${text}`}>
        <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
        {statusText[turn.status]}
      </span>
      {turn.status !== "running" && (
        <button type="button" className="caps-link text-fg" onClick={() => onChanges(turn.turnId)}>
          Changes
        </button>
      )}
      {revertable && !reverting && (
        <button type="button" className="caps-link text-fg" onClick={() => setReverting(true)}>
          Revert to here
        </button>
      )}
      {revertable && reverting && (
        // biome-ignore lint/a11y/useSemanticElements: a group of buttons, not a form field set.
        <span role="group" aria-label="Revert the thread to the end of this turn" className="flex items-center gap-1.5">
          <span>Revert</span>
          <button type="button" className="px-2 text-xs" onClick={() => onRevert(turn.turnId, false)}>
            Conversation
          </button>
          <button type="button" className="px-2 text-xs" onClick={() => onRevert(turn.turnId, true)}>
            Conversation and files
          </button>
          <button type="button" className="px-2 text-xs" onClick={() => setReverting(false)}>
            Cancel
          </button>
        </span>
      )}
      {task && turn.status !== "running" && <Rating task={task} onRate={onRate} />}
      {turn.error && <span className="text-error">{turn.error}</span>}
      {turn.usage.map((u) => (
        <span
          key={u.model}
          className="font-mono tabular-nums"
          title={`cache read ${u.cacheReadTokens} · cache write ${u.cacheWriteTokens} tokens`}
        >
          {u.model} · {u.inputTokens}→{u.outputTokens} tok · ${u.costUsd.toFixed(4)} · {u.accessMode}
        </span>
      ))}
    </footer>
  );
};

/** Thumbs up or down on a finished task, for routing memory and the lab; pressing the chosen one again clears it. */
const Rating = ({ task, onRate }: { task: Task; onRate: TurnProps["onRate"] }) => (
  // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a form field set.
  <span role="group" aria-label="Rate this task" className="flex items-center gap-1">
    {([1, -1] as const).map((rating) => (
      <button
        key={rating}
        type="button"
        aria-pressed={task.rating === rating}
        aria-label={rating === 1 ? "Good result" : "Bad result"}
        title={rating === 1 ? "Good result" : "Bad result: the router counts it as a task that didn't succeed"}
        className="px-1.5 text-xs aria-pressed:border-accent aria-pressed:text-accent"
        onClick={() => onRate(task.taskId, task.rating === rating ? null : rating)}
      >
        {rating === 1 ? <ThumbUpIcon className="size-3.5" /> : <ThumbDownIcon className="size-3.5" />}
      </button>
    ))}
  </span>
);

type ToolResult = Extract<Item, { kind: "tool.result" }>;
type Escalation = Extract<Item, { kind: "escalation" }>;
/**
 * Results sit under their call, a subagent's steps under the call that started it, and the escalation a rejected plan
 * set off on its plan's card.
 */
type Tree = {
  readonly results: ReadonlyMap<string, ToolResult>;
  readonly children: ReadonlyMap<string, Item[]>;
  readonly rejections: ReadonlyMap<string, Escalation>;
};

const parentOf = (item: Item) => ("parentToolUseId" in item ? item.parentToolUseId : undefined);

const Items = memo(({ items }: { items: TurnView["items"] }) => {
  const results = new Map(items.flatMap((i) => (i.kind === "tool.result" ? [[i.toolUseId, i] as const] : [])));
  const calls = new Set(items.flatMap((i) => (i.kind === "tool.call" ? [i.toolUseId] : [])));
  const plans = new Set(items.flatMap((i) => (i.kind === "plan" && i.requestId ? [i.requestId] : [])));
  const rejections = new Map(
    items.flatMap((i) => (i.kind === "escalation" && i.requestId && plans.has(i.requestId) ? [[i.requestId, i] as const] : [])),
  );
  const shown = items.filter(
    (i) =>
      (i.kind !== "tool.result" || !calls.has(i.toolUseId)) && (i.kind !== "escalation" || !i.requestId || !rejections.has(i.requestId)),
  );
  const children = Map.groupBy(
    shown.filter((i) => parentOf(i) !== undefined),
    (i) => parentOf(i) ?? "",
  );
  return <ItemList items={shown.filter((i) => parentOf(i) === undefined)} tree={{ results, children, rejections }} />;
});

const ItemList = ({ items, tree }: { items: readonly Item[]; tree: Tree }) => (
  <>
    {items.map((item, i) => {
      const View = itemViews[item.kind] as (props: { item: Item; tree: Tree }) => ReactNode;
      // Items only ever append, so the index is a stable key.
      // biome-ignore lint/suspicious/noArrayIndexKey: see above.
      return <View key={i} item={item} tree={tree} />;
    })}
  </>
);

/** Long output cut to keep rendering cheap: about `max` characters, never half an emoji. */
const clipOutput = (text: string, max = 4000) => {
  const end = codePointStart(text, max);
  return text.length > max ? `${text.slice(0, end)}\n… ${text.length - end} more characters` : text;
};

/** The one input field that says what a tool call is about, e.g. the file or the command. */
const summarize = (input: unknown) => {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  const value = ["file_path", "command", "pattern", "path", "url", "description", "prompt", "task"]
    .map((k) => record[k])
    .find((v) => typeof v === "string");
  return typeof value === "string" ? clip(value, 80) : "";
};

const itemViews: { [K in Item["kind"]]: (props: { item: Extract<Item, { kind: K }>; tree: Tree }) => ReactNode } = {
  "assistant.message": ({ item }) => (
    <div>
      <Markdown text={item.text} />
    </div>
  ),
  "user.steer": ({ item }) => (
    <UserBubble label="You, while it worked">
      <p className="mt-0.5 mb-0">{item.text}</p>
    </UserBubble>
  ),
  // A plan approved with the user's edit shows the edit against the proposal; a rejected one, the escalation it set off.
  plan: ({ item, tree }) => {
    const escalation = item.requestId === undefined ? undefined : tree.rejections.get(item.requestId);
    return (
      <div className="my-3 border border-line border-l-2 border-l-accent bg-card px-4 py-3">
        <span className="eyebrow text-accent">
          Plan
          <span className="font-normal tracking-normal text-muted normal-case">
            {item.edited === undefined ? "" : " · approved with your edits"}
            {escalation ? " · rejected" : ""}
            {item.filePath ? ` · ${item.filePath}` : ""}
          </span>
        </span>
        {item.edited === undefined ? <Markdown text={item.text} /> : <TextDiff before={item.text} after={item.edited} />}
        {escalation?.to && (
          <p className="mt-2 mb-0 border-t border-line pt-2 text-xs text-muted">
            Escalated: {describeRouteChange(escalation.from, escalation.to)}. {escalation.reason}
          </p>
        )}
      </div>
    );
  },
  "route.switch": ({ item }) => (
    <p className="my-3 flex items-center gap-3 text-xs text-muted before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
      <span className="max-w-[80%] text-center">
        Route changed by the router: {describeRouteChange(item.from, item.to)}. {item.reason}
      </span>
    </p>
  ),
  // Under the delegate_task call it routed, with the child's steps.
  delegation: ({ item }) => (
    <p className="my-1 text-xs text-muted">
      Routed as a task of its own, on {item.route.model}: {item.reason}
    </p>
  ),
  compression: ({ item }) => (
    <p className="my-3 flex items-center gap-3 text-xs text-muted before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
      <span className="max-w-[80%] text-center">{describeCompression(item)}</span>
    </p>
  ),
  effort: ({ item }) => (
    <p className="my-3 flex items-center gap-3 text-xs text-muted before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
      <span className="max-w-[80%] text-center">
        Effort for this turn: {item.from} → {item.to}. {item.reason}
      </span>
    </p>
  ),
  escalation: ({ item }) => (
    <p className="my-3 flex items-center gap-3 text-xs text-muted before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">
      <span className="max-w-[80%] text-center">
        {item.to ? `Escalated: ${describeRouteChange(item.from, item.to)}. ` : "Not escalated. "}
        {item.reason}
      </span>
    </p>
  ),
  // What the new session was handed, folded: the user opens it to see what carried over.
  handoff: ({ item }) => (
    <details className="my-1.5 rounded border border-line bg-card">
      <summary className="flex list-none items-center gap-2 rounded px-2 py-1 text-xs hover:bg-hover [&::-webkit-details-marker]:hidden">
        <ChevronIcon className="size-3.5 text-muted [details[open]>summary>&]:rotate-90" />
        <span className="font-semibold">Handed over</span>
        <span className="min-w-0 flex-1 truncate text-muted">
          from {item.from} to a new {item.to} session, with this summary of the thread so far
        </span>
      </summary>
      <div className="border-t border-line px-3 py-1">
        <Markdown text={item.summary} />
      </div>
    </details>
  ),
  blocked: ({ item }) => (
    <p role="note" className="my-2 border border-line border-l-2 border-l-warn bg-card px-3 py-1.5 text-xs">
      <span className="font-medium text-warn">The agent is blocked: </span>
      {item.reason}
    </p>
  ),
  injection: ({ item }) => (
    <p role="note" className="my-2 border border-line border-l-2 border-l-warn bg-card px-3 py-1.5 text-xs">
      <span className="font-medium text-warn">{injectionLead(item)} </span>
      {item.why}
    </p>
  ),
  // Smart approvals ran or refused a command without asking (DESIGN §17).
  "approval.auto": ({ item }) => (
    <p role="note" className={`my-1 text-xs ${item.decision === "deny" ? "text-warn" : "text-muted"}`}>
      {item.decision === "allow" ? "Auto-approved by smart approvals" : "Refused by smart approvals"}: {item.reason}
    </p>
  ),
  notice: ({ item }) => (
    <p role="note" className="my-2 border border-line bg-card px-3 py-1.5 text-xs text-warn">
      {item.text}
    </p>
  ),
  verifier: ({ item }) => (
    <details className="my-1.5 rounded border border-line bg-card">
      <summary className="flex list-none items-center gap-2 rounded px-2 py-1 font-mono text-xs hover:bg-hover [&::-webkit-details-marker]:hidden">
        <ChevronIcon className="size-3.5 text-muted [details[open]>summary>&]:rotate-90" />
        <span className="font-semibold">Verifier</span>
        <span className="min-w-0 flex-1 truncate text-muted">{item.command}</span>
        <span className="shrink-0 tabular-nums text-muted">{(item.durationMs / 1000).toFixed(1)}s</span>
        {item.passed ? (
          <span className="shrink-0 rounded bg-added px-1.5 text-ok">passed</span>
        ) : (
          <span className="shrink-0 rounded bg-removed px-1.5 text-error">
            failed{item.exitCode === null ? "" : ` · exit ${item.exitCode}`}
          </span>
        )}
      </summary>
      <div className="border-t border-line px-2 py-1">
        <pre className={item.passed ? undefined : "text-error"}>{clipOutput(item.output) || "(no output)"}</pre>
      </div>
    </details>
  ),
  "tool.call": ({ item, tree }) => {
    const result = tree.results.get(item.toolUseId);
    const steps = tree.children.get(item.toolUseId);
    return (
      <details className="my-1.5 rounded border border-line bg-card">
        <summary className="flex list-none items-center gap-2 rounded px-2 py-1 font-mono text-xs hover:bg-hover [&::-webkit-details-marker]:hidden">
          <ChevronIcon className="size-3.5 text-muted [details[open]>summary>&]:rotate-90" />
          <span className="font-semibold">{item.name}</span>
          <span className="min-w-0 flex-1 truncate text-muted">{summarize(item.input)}</span>
          {result?.isError && <span className="shrink-0 rounded bg-removed px-1.5 text-error">failed</span>}
        </summary>
        <div className="border-t border-line px-2 py-1">
          <pre>{clipOutput(JSON.stringify(item.input, null, 2) ?? "")}</pre>
          {steps && (
            <div className="my-1 border-l-2 border-line pl-3">
              <ItemList items={steps} tree={tree} />
            </div>
          )}
          {result && <pre className={result.isError ? "text-error" : undefined}>{clipOutput(result.content)}</pre>}
        </div>
      </details>
    );
  },
  "tool.result": ({ item }) => <pre className={item.isError ? "text-error" : undefined}>{clipOutput(item.content)}</pre>,
};

/** The thread's latest revert, until its next turn: what was reverted, and Undo while nothing has run since. */
const RevertBar = ({
  connection,
  threadId,
  thread,
  error,
  onError,
}: {
  connection: Connection;
  threadId: ThreadId;
  thread: LiveThread;
  error: string | undefined;
  onError: (message: string | undefined) => void;
}) => {
  const { revert } = thread;
  const number = revert ? thread.turns.findIndex((t) => t.turnId === revert.toTurnId) + 1 : 0;
  const what = revert?.files ? "the conversation and files" : "the conversation";
  const message =
    error ??
    (revert?.undone
      ? "Revert undone."
      : revert &&
        [
          `Reverted ${what} to the end of turn ${number}. The next turn continues from there.`,
          ...(revert.filesError ? [`The files weren't restored: ${revert.filesError}`] : []),
          ...describeRevertFiles(revert),
        ].join(" "));
  return (
    <div className="flex items-center gap-3 border-b border-line bg-panel px-4 py-1.5 text-xs">
      <p role="status" className={`min-w-0 flex-1 ${error || revert?.filesError ? "text-error" : "text-muted"}`}>
        {message}
      </p>
      {revert && !revert.undone && !thread.busy && (
        <button
          type="button"
          className="px-2 text-xs"
          onClick={() =>
            void connection
              .dispatch({ type: "thread.revert.undo", commandId: uuid<CommandId>(), threadId })
              .then((r) => onError(r.ok ? undefined : r.message))
          }
        >
          Undo
        </button>
      )}
    </div>
  );
};
