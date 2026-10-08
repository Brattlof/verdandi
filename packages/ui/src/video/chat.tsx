import type { CommandId, ThreadId } from "@verdandi/contracts";
import { useState } from "react";
import { type Connection, uuid } from "../client.ts";
import type { Sidebar } from "../state.ts";
import { ThreadPane } from "../threads/thread.tsx";

/**
 * The agent, next to the preview: this video project's threads (newest first) and the one open, or a new thread in
 * the project's folder. What the agent changes reloads the preview through the Studio's file watcher.
 */
export const ProjectChat = ({ connection, data, path }: { connection: Connection; data: Sidebar | undefined; path: string }) => {
  const project = data?.projects.find((p) => p.path === path);
  const threads = (data?.threads ?? [])
    .filter((t) => project && t.projectId === project.projectId && !t.archived)
    .toSorted((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  const [chosen, setChosen] = useState<ThreadId>();
  const [error, setError] = useState<string>();
  const open = chosen ?? threads[0]?.threadId;

  const create = async () => {
    setError(undefined);
    const threadId = uuid<ThreadId>();
    const result = await connection.dispatch({ type: "thread.create", commandId: uuid<CommandId>(), threadId, projectPath: path });
    if (result.ok) setChosen(threadId);
    else setError(result.message);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5">
        <label htmlFor="video-thread" className="sr-only">
          Thread
        </label>
        <select
          id="video-thread"
          value={open ?? ""}
          onChange={(e) => setChosen(e.target.value as ThreadId)}
          className="min-w-0 flex-1"
          disabled={!threads.length}
        >
          {threads.length === 0 && <option value="">No threads in this project yet</option>}
          {threads.map((t) => (
            <option key={t.threadId} value={t.threadId}>
              {t.title || "New thread"}
              {t.busy ? " · working" : ""}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void create()}>
          New thread
        </button>
      </div>
      {error && (
        <p role="alert" className="border-b border-line px-3 py-2 text-error">
          {error}
        </p>
      )}
      {open ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <ThreadPane key={open} connection={connection} threadId={open} focusTurn={null} />
        </div>
      ) : (
        <p className="p-4 text-muted">Start a thread to have an agent edit this video with you: ask for a scene, a change or a render.</p>
      )}
    </div>
  );
};
