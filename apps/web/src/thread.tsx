import { useVirtualizer } from "@tanstack/react-virtual";
import type { InteractionMode, Item, ThreadId, TurnView } from "@verdandi/contracts";
import { memo, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { type Connection, createStore, useStore } from "./client.ts";
import { Composer, Requests } from "./composer.tsx";
import { applyThreadFeed, type LiveThread, type LiveTurn } from "./state.ts";

export const ThreadPane = ({ connection, threadId }: { connection: Connection; threadId: ThreadId }) => {
  const [store] = useState(() => createStore<LiveThread | undefined>(undefined));
  const [error, setError] = useState<string>();
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
  if (error) return <p role="alert">{error}</p>;
  if (!thread) return null;
  const { harness, model, effort } = thread.route;
  const last = thread.turns.at(-1);
  return (
    <>
      <header className="thread-header">
        <span title={thread.projectPath}>{thread.projectPath}</span>
        <span className="chip">
          {harness} · {model} · {effort}
        </span>
      </header>
      <Conversation turns={thread.turns} />
      <Requests connection={connection} threadId={threadId} requests={thread.pendingRequests} onPlanApproved={() => setMode("build")} />
      <Composer connection={connection} thread={thread} mode={mode ?? last?.mode ?? "build"} onMode={setMode} />
      <div role="status" className="sr-only">
        {thread.pendingRequests.length > 0
          ? "The agent is waiting for your answer."
          : last && last.status !== "running"
            ? `Turn ${statusText[last.status].toLowerCase()}.`
            : ""}
      </div>
    </>
  );
};

/** Only the turns in view are rendered. The list follows new output while scrolled to the bottom. */
const Conversation = ({ turns }: { turns: readonly LiveTurn[] }) => {
  const scroller = useRef<HTMLElement>(null);
  const atBottom = useRef(true);
  const virtualizer = useVirtualizer({
    count: turns.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 160,
    overscan: 4,
    getItemKey: (i) => turns[i]?.turnId ?? i,
  });
  // Runs after every render, including the virtualizer's own after it measures a turn.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });
  return (
    <section
      ref={scroller}
      className="conversation"
      aria-label="Conversation"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable to scroll it with the keyboard.
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      }}
    >
      {turns.length === 0 && <p className="empty">No turns yet. Send a message below.</p>}
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((row) => {
          const turn = turns[row.index];
          return (
            turn && (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className="row"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <Turn turn={turn} />
              </div>
            )
          );
        })}
      </div>
    </section>
  );
};

const statusText: Record<LiveTurn["status"], string> = { running: "Working", success: "Done", error: "Failed", interrupted: "Stopped" };

const Turn = memo(({ turn }: { turn: LiveTurn }) => (
  <article className="turn">
    <div className="user">
      <span className="who">You{turn.mode === "build" ? "" : ` · ${turn.mode}`}</span>
      <p>{turn.text}</p>
    </div>
    <Items items={turn.items} />
    {turn.streaming && <p className="assistant">{turn.streaming}</p>}
    <TurnStatus turn={turn} />
  </article>
));

const TurnStatus = ({ turn }: { turn: LiveTurn }) => (
  <footer className="turn-status">
    <span className={`status ${turn.status}`}>{statusText[turn.status]}</span>
    {turn.error && <span className="error">{turn.error}</span>}
    {turn.usage.map((u) => (
      <span key={u.model} title={`cache read ${u.cacheReadTokens} · cache write ${u.cacheWriteTokens} tokens`}>
        {u.model} · {u.inputTokens}→{u.outputTokens} tok · ${u.costUsd.toFixed(4)} · {u.accessMode}
      </span>
    ))}
  </footer>
);

type ToolResult = Extract<Item, { kind: "tool.result" }>;
/** Results sit under their call, and a subagent's steps under the call that started it. */
type Tree = { readonly results: ReadonlyMap<string, ToolResult>; readonly children: ReadonlyMap<string, Item[]> };

const parentOf = (item: Item) => ("parentToolUseId" in item ? item.parentToolUseId : undefined);

const Items = memo(({ items }: { items: TurnView["items"] }) => {
  const results = new Map(items.flatMap((i) => (i.kind === "tool.result" ? [[i.toolUseId, i] as const] : [])));
  const calls = new Set(items.flatMap((i) => (i.kind === "tool.call" ? [i.toolUseId] : [])));
  const shown = items.filter((i) => i.kind !== "tool.result" || !calls.has(i.toolUseId));
  const children = Map.groupBy(
    shown.filter((i) => parentOf(i) !== undefined),
    (i) => parentOf(i) ?? "",
  );
  return <ItemList items={shown.filter((i) => parentOf(i) === undefined)} tree={{ results, children }} />;
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

const clip = (text: string, max = 4000) => (text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters` : text);

/** The one input field that says what a tool call is about, e.g. the file or the command. */
const summarize = (input: unknown) => {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  const value = ["file_path", "command", "pattern", "path", "url", "description", "prompt"]
    .map((k) => record[k])
    .find((v) => typeof v === "string");
  return typeof value === "string" ? (value.length > 80 ? `${value.slice(0, 79)}…` : value) : "";
};

const itemViews: { [K in Item["kind"]]: (props: { item: Extract<Item, { kind: K }>; tree: Tree }) => ReactNode } = {
  "assistant.message": ({ item }) => <p className="assistant">{item.text}</p>,
  "user.steer": ({ item }) => (
    <div className="user steer">
      <span className="who">You, while it worked</span>
      <p>{item.text}</p>
    </div>
  ),
  plan: ({ item }) => (
    <div className="plan">
      <span className="who">Plan{item.filePath ? ` · ${item.filePath}` : ""}</span>
      <p>{item.text}</p>
    </div>
  ),
  "tool.call": ({ item, tree }) => {
    const result = tree.results.get(item.toolUseId);
    const steps = tree.children.get(item.toolUseId);
    return (
      <details className="tool">
        <summary>
          {item.name} <span className="muted">{summarize(item.input)}</span>
          {result?.isError && <span className="error"> failed</span>}
        </summary>
        <pre>{clip(JSON.stringify(item.input, null, 2) ?? "")}</pre>
        {steps && (
          <div className="subagent">
            <ItemList items={steps} tree={tree} />
          </div>
        )}
        {result && <pre className={result.isError ? "error" : undefined}>{clip(result.content)}</pre>}
      </details>
    );
  },
  "tool.result": ({ item }) => <pre className={item.isError ? "error" : undefined}>{clip(item.content)}</pre>,
};
