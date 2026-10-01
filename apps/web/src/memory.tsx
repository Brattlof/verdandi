import { type CommandId, type MemoryEntry, type MemoryScope, type MemoryView, memoryCaps, type ThreadId } from "@verdandi/contracts";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Raven } from "./art.tsx";
import { type Connection, uuid } from "./client.ts";

const titles: Record<MemoryScope, string> = { user: "About you", project: "About this project" };
const day = (iso: string) => new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });

/**
 * The Memory tab (DESIGN §14.2): what Verdandi remembers about the user and the thread's project, which new
 * sessions start with. Everything can be added, edited and deleted here; saves are scanned like the agent's.
 */
export const MemoryTab = ({ connection, threadId }: { connection: Connection; threadId: ThreadId }) => {
  const [view, setView] = useState<MemoryView>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => void connection.memory(threadId).then(setView), [connection, threadId]);
  useEffect(load, [load]);
  /** Sends a memory command, then shows the store as it is now, or why it was refused. */
  const send = async (command: Parameters<Connection["dispatch"]>[0]) => {
    const result = await connection.dispatch(command);
    setError(result.ok ? undefined : result.message);
    load();
    return result.ok;
  };
  if (!view) return <p className="p-3 text-xs text-muted">Loading…</p>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-xs">
      <p className="flex items-center gap-2 font-serif text-lg font-semibold">
        <Raven className="size-7" />
        Muninn remembers
      </p>
      <p className="mt-1 text-muted">
        New sessions start with these. The agent saves facts with memory_save; it never edits CLAUDE.md or AGENTS.md. Saves show from the
        next session on.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-error [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      {(["user", "project"] as const).map((scope) => (
        <Store key={scope} scope={scope} entries={view[scope]} threadId={threadId} projectPath={view.projectPath} send={send} />
      ))}
    </div>
  );
};

type Send = (command: Parameters<Connection["dispatch"]>[0]) => Promise<boolean>;

const Store = ({
  scope,
  entries,
  threadId,
  projectPath,
  send,
}: {
  scope: MemoryScope;
  entries: readonly MemoryEntry[];
  threadId: ThreadId;
  projectPath: string;
  send: Send;
}) => {
  const used = entries.reduce((n, e) => n + [...e.text].length, 0);
  const headingId = `memory-${scope}`;
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const text = String(new FormData(form).get("text")).trim();
    if (text && (await send({ type: "memory.save", commandId: uuid<CommandId>(), threadId, scope, text }))) form.reset();
  };
  return (
    <section aria-labelledby={headingId} className="mt-4">
      <h3 id={headingId} className="flex items-baseline justify-between gap-2 font-serif text-lg font-semibold">
        {titles[scope]}
        <span className="shrink-0 font-sans text-xs font-normal tabular-nums text-muted">
          {used} / {memoryCaps[scope]} characters
        </span>
      </h3>
      {scope === "project" && (
        <p title={projectPath} className="truncate font-mono text-muted">
          {projectPath}
        </p>
      )}
      {entries.length === 0 && <p className="mt-1 text-muted">Nothing yet.</p>}
      <ul className="mt-1">
        {entries.map((e) => (
          <Entry key={e.entryId} entry={e} threadId={threadId} send={send} />
        ))}
      </ul>
      <form onSubmit={add} className="mt-2 flex gap-1.5">
        <label htmlFor={`${headingId}-new`} className="sr-only">
          Add to {titles[scope].toLowerCase()}
        </label>
        <input
          id={`${headingId}-new`}
          type="text"
          name="text"
          placeholder="A fact to remember"
          autoComplete="off"
          className="min-w-0 flex-1"
        />
        <button type="submit" className="px-2 text-xs">
          Add
        </button>
      </form>
    </section>
  );
};

const Entry = ({ entry, threadId, send }: { entry: MemoryEntry; threadId: ThreadId; send: Send }) => {
  const [editing, setEditing] = useState(false);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get("text")).trim();
    if (await send({ type: "memory.edit", commandId: uuid<CommandId>(), threadId, entryId: entry.entryId, text })) setEditing(false);
  };
  const by = entry.source.turnId ? "saved by the agent" : "added by you";
  return (
    <li className="border-b border-line py-1.5">
      {editing ? (
        <form onSubmit={save} className="flex flex-col gap-1.5">
          <label htmlFor={`edit-${entry.entryId}`} className="sr-only">
            Edit this memory
          </label>
          {/* biome-ignore lint/a11y/noAutofocus: the user just asked to edit this entry. */}
          <textarea id={`edit-${entry.entryId}`} name="text" defaultValue={entry.text} rows={3} autoFocus />
          <span className="flex gap-1.5">
            <button type="submit" className="px-2 text-xs">
              Save
            </button>
            <button type="button" className="px-2 text-xs" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </span>
        </form>
      ) : (
        <>
          <p className="[overflow-wrap:anywhere]">{entry.text}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-muted">
            <span>
              {by}, confirmed {day(entry.confirmedAt)}
            </span>
            <button type="button" className="caps-link text-fg" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button
              type="button"
              className="caps-link text-fg"
              aria-label={`Delete: ${entry.text.slice(0, 60)}`}
              onClick={() => void send({ type: "memory.delete", commandId: uuid<CommandId>(), threadId, entryId: entry.entryId })}
            >
              Delete
            </button>
          </p>
        </>
      )}
    </li>
  );
};
