import { Tabs } from "@base-ui/react/tabs";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DiffView, ThreadId, TurnId } from "@verdandi/contracts";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Connection } from "./client.ts";
import { ChevronIcon, CloseIcon } from "./icons.tsx";
import type { OpenPanel } from "./state.ts";
import { TerminalTab } from "./terminal.tsx";

type LineKind = "add" | "del" | "hunk" | "context" | "meta";
export type DiffRow =
  | { readonly kind: "file"; readonly key: string; readonly path: string; readonly expanded: boolean }
  | { readonly kind: "line"; readonly key: string; readonly line: LineKind; readonly text: string }
  | { readonly kind: "note"; readonly key: string; readonly text: string };

/** A hunk line's first character says what it is; a `\ No newline` marker counts as context. */
const hunkLines: Record<string, LineKind> = { "@": "hunk", "+": "add", "-": "del" };

/** Only lines inside a hunk are added or removed: before the first `@@`, `--- a/x` is a header. */
const classify = (diff: string) => {
  let inHunk = false;
  return diff
    .split("\n")
    .filter((text, i, lines) => text !== "" || i < lines.length - 1)
    .map((text) => {
      inHunk ||= text.startsWith("@@");
      return { line: inHunk ? (hunkLines[text.charAt(0)] ?? "context") : ("meta" as LineKind), text };
    });
};

/** The panel's rows, one list for the virtualizer: each file's header, then its lines unless collapsed. */
export const diffRows = (view: DiffView, collapsed: ReadonlySet<string>): DiffRow[] => [
  ...view.files.flatMap((file, f): DiffRow[] => {
    const expanded = !collapsed.has(file.path);
    const header: DiffRow = { kind: "file", key: `${f}`, path: file.path, expanded };
    if (!expanded) return [header];
    return [
      header,
      ...classify(file.diff).map((l, i): DiffRow => ({ kind: "line", key: `${f}:${i}`, ...l })),
      ...(file.truncated
        ? [{ kind: "note", key: `${f}:cut`, text: "The rest of this file's diff was cut to keep it small." } as const]
        : []),
    ];
  }),
  ...(view.omittedFiles > 0
    ? [
        {
          kind: "note",
          key: "omitted",
          text: `${view.omittedFiles} more changed ${view.omittedFiles === 1 ? "file was" : "files were"} left out to keep this small. Run git diff in the project to see them.`,
        } as const,
      ]
    : []),
];

const signs: Partial<Record<LineKind, string>> = { add: "added: ", del: "removed: " };
const rowClass: Record<LineKind | "file" | "note", string> = {
  add: "bg-added",
  del: "bg-removed",
  hunk: "bg-panel text-accent",
  meta: "text-muted",
  context: "",
  file: "pt-3",
  note: "py-1 font-sans italic text-muted",
};

const tabClass =
  "rounded-none border-0 border-b-2 border-transparent bg-transparent px-1 text-xs text-muted hover:bg-transparent hover:text-fg data-active:border-accent data-active:text-fg";

/**
 * The right panel: the Diff tab and the Terminal tab. The diff is fetched when asked, never on its own,
 * and renders only the rows in view. `turnLabel` names `panel.turnId`. Escape closes the panel, except
 * inside a terminal, where it goes to the shell.
 */
export const SidePanel = ({
  connection,
  threadId,
  panel,
  turnLabel,
  onFetch,
  onTerminal,
  onClose,
}: {
  connection: Connection;
  threadId: ThreadId;
  panel: OpenPanel;
  turnLabel: string | undefined;
  onFetch: (turnId: TurnId | undefined, all: boolean) => void;
  onTerminal: () => void;
  onClose: () => void;
}) => {
  const id = useId();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const aside = useRef<HTMLElement>(null);
  // Focus moves into the panel when it opens, so keyboard users land on what they asked for.
  useEffect(() => aside.current?.focus(), []);
  const { turnId, result } = panel;
  // The thread re-renders on every streamed delta; the rows only change with the result or a toggle.
  const rows = useMemo(() => (result?.ok ? diffRows(result.view, collapsed) : undefined), [result, collapsed]);
  const toggle = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  return (
    <aside
      ref={aside}
      onKeyDown={(e) => e.key === "Escape" && !(e.target instanceof Element && e.target.closest(".xterm")) && onClose()}
      aria-label="Side panel"
      tabIndex={-1}
      className="fixed inset-0 z-40 flex min-w-0 bg-bg outline-none md:static md:z-auto md:w-[min(50%,760px)] md:border-l md:border-line"
    >
      <Tabs.Root
        value={panel.tab}
        onValueChange={(tab) => (tab === "terminal" ? onTerminal() : onFetch(panel.turnId, panel.all))}
        className="flex min-w-0 flex-1 flex-col"
      >
        <div className="flex min-h-12 items-center justify-between border-b border-line px-3">
          <Tabs.List aria-label="Panel" className="flex gap-3">
            <Tabs.Tab value="diff" className={tabClass}>
              Diff
            </Tabs.Tab>
            <Tabs.Tab value="terminal" className={tabClass}>
              Terminal
            </Tabs.Tab>
          </Tabs.List>
          <button type="button" className="px-2 text-xs" onClick={onClose}>
            <CloseIcon className="size-3.5" />
            Close
          </button>
        </div>
        <Tabs.Panel value="diff" className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-2">
            <fieldset className="flex rounded-lg border border-line bg-panel p-0.5">
              <legend className="sr-only">Show</legend>
              <label className="inline-flex min-h-6 items-center rounded-md px-2.5 text-xs font-medium text-muted hover:text-fg has-checked:bg-card has-checked:text-fg has-checked:shadow-[inset_0_0_0_1px_var(--color-line-strong)] has-focus-visible:outline-2 has-focus-visible:outline-accent has-disabled:opacity-45 pointer-coarse:min-h-10">
                <input
                  type="radio"
                  className="sr-only"
                  name={`${id}-scope`}
                  checked={!panel.all}
                  disabled={!turnId}
                  onChange={() => onFetch(turnId, false)}
                />
                {turnLabel ?? "Last turn"}
              </label>
              <label className="inline-flex min-h-6 items-center rounded-md px-2.5 text-xs font-medium text-muted hover:text-fg has-checked:bg-card has-checked:text-fg has-checked:shadow-[inset_0_0_0_1px_var(--color-line-strong)] has-focus-visible:outline-2 has-focus-visible:outline-accent has-disabled:opacity-45 pointer-coarse:min-h-10">
                <input
                  type="radio"
                  className="sr-only"
                  name={`${id}-scope`}
                  checked={panel.all}
                  onChange={() => onFetch(panel.turnId, true)}
                />
                All changes
              </label>
            </fieldset>
            <button type="button" className="text-xs" onClick={() => onFetch(panel.turnId, panel.all)}>
              Refresh
            </button>
          </div>
          <p role="status" className={`mx-3 my-2 text-xs ${result?.ok === false ? "text-error" : "text-muted"}`}>
            {statusText(panel)}
          </p>
          {rows && <DiffList rows={rows} onToggle={toggle} />}
        </Tabs.Panel>
        <Tabs.Panel value="terminal" className="flex min-h-0 flex-1 flex-col">
          <TerminalTab connection={connection} threadId={threadId} />
        </Tabs.Panel>
      </Tabs.Root>
    </aside>
  );
};

const statusText = ({ all, result }: OpenPanel) => {
  if (result === undefined) return "Loading…";
  if (!result.ok) return result.message;
  const count = result.view.files.length + result.view.omittedFiles;
  if (count === 0) return all ? "No changes since the thread's first turn." : "This turn changed no files.";
  return `${count} changed ${count === 1 ? "file" : "files"}${all ? " since the thread's first turn" : " in this turn"}.`;
};

const DiffList = ({ rows, onToggle }: { rows: readonly DiffRow[]; onToggle: (path: string) => void }) => {
  const scroller = useRef<HTMLElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 20,
    overscan: 20,
    getItemKey: (i) => rows[i]?.key ?? i,
  });
  return (
    <section
      ref={scroller}
      className="flex-1 overflow-y-auto whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable to scroll it with the keyboard.
      tabIndex={0}
      aria-label="Changed files"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className={`absolute top-0 left-0 w-full px-3 ${rowClass[row.kind === "line" ? row.line : row.kind]}`}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row.kind === "file" ? (
                <button
                  type="button"
                  className="w-full justify-start rounded-md border-line bg-panel px-2 text-left font-semibold [overflow-wrap:anywhere]"
                  aria-expanded={row.expanded}
                  onClick={() => onToggle(row.path)}
                >
                  <ChevronIcon className={`size-3.5 text-muted ${row.expanded ? "rotate-90" : ""}`} />
                  {row.path}
                </button>
              ) : row.kind === "note" ? (
                row.text
              ) : (
                <>
                  {signs[row.line] && <span className="sr-only">{signs[row.line]}</span>}
                  {row.text}
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
};
