import { Tabs } from "@base-ui/react/tabs";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DiffView, TurnId } from "@verdandi/contracts";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { DiffPanel } from "./state.ts";

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
  hunk: "text-muted",
  meta: "text-muted",
  context: "",
  file: "pt-2",
  note: "font-sans italic text-muted",
};

/**
 * The right panel, switchable; only "Diff" exists so far. It fetches when asked, never on its own,
 * and renders only the rows in view. `turnLabel` names `panel.turnId`.
 */
export const SidePanel = ({
  panel,
  turnLabel,
  onFetch,
  onClose,
}: {
  panel: Extract<DiffPanel, { open: true }>;
  turnLabel: string | undefined;
  onFetch: (turnId: TurnId | undefined, all: boolean) => void;
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
    <aside ref={aside} aria-label="Side panel" tabIndex={-1} className="flex w-[min(50%,760px)] min-w-0 border-l border-line">
      <Tabs.Root defaultValue="diff" className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-line px-2 py-1">
          <Tabs.List aria-label="Panel">
            <Tabs.Tab value="diff" className="px-2 py-0 text-xs data-active:border-accent">
              Diff
            </Tabs.Tab>
          </Tabs.List>
          <button type="button" className="px-2 py-0 text-xs" onClick={onClose}>
            Close
          </button>
        </div>
        <Tabs.Panel value="diff" className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between px-2 pt-1.5">
            <fieldset className="mb-1 flex items-center gap-3">
              <legend className="sr-only">Show</legend>
              <label>
                <input type="radio" name={`${id}-scope`} checked={!panel.all} disabled={!turnId} onChange={() => onFetch(turnId, false)} />
                {turnLabel ?? "Last turn"}
              </label>
              <label>
                <input type="radio" name={`${id}-scope`} checked={panel.all} onChange={() => onFetch(panel.turnId, true)} />
                All changes
              </label>
            </fieldset>
            <button type="button" onClick={() => onFetch(panel.turnId, panel.all)}>
              Refresh
            </button>
          </div>
          <p role="status" className={`mx-2 my-1 text-xs ${result?.ok === false ? "text-error" : "text-muted"}`}>
            {statusText(panel)}
          </p>
          {rows && <DiffList rows={rows} onToggle={toggle} />}
        </Tabs.Panel>
      </Tabs.Root>
    </aside>
  );
};

const statusText = ({ all, result }: Extract<DiffPanel, { open: true }>) => {
  if (result === undefined) return "Loading…";
  if (!result.ok) return result.message;
  const count = result.view.files.length + result.view.omittedFiles;
  if (count === 0) return all ? "No changes against HEAD." : "The files this turn touched have no changes against HEAD.";
  return `${count} changed ${count === 1 ? "file" : "files"}${all ? " against HEAD" : ", as they differ from HEAD now"}.`;
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
              className={`absolute top-0 left-0 w-full px-2 ${rowClass[row.kind === "line" ? row.line : row.kind]}`}
              style={{ transform: `translateY(${item.start}px)` }}
            >
              {row.kind === "file" ? (
                <button
                  type="button"
                  className="w-full text-left font-semibold"
                  aria-expanded={row.expanded}
                  onClick={() => onToggle(row.path)}
                >
                  <span aria-hidden="true">{row.expanded ? "▾" : "▸"}</span> {row.path}
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
