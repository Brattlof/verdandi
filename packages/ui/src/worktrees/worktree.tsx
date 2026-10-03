import type { ClientCommand, CommandId, ThreadId, WorktreeView } from "@verdandi/contracts";
import { useState } from "react";
import { type Connection, uuid } from "../client.ts";

const said: Record<WorktreeView["state"], (w: WorktreeView) => string | undefined> = {
  creating: (w) => `Adding a worktree on branch ${w.branch}. The first turn starts once it's ready.`,
  ready: (w) => w.error ?? (w.held && `Setup ${w.held} waits for you to trust it: the next turn asks before the agent starts.`),
  failed: (w) => `The worktree couldn't be added: ${w.error ?? "no reason recorded"}`,
  removing: () => "Removing the worktree…",
  removed: (w) => `The worktree was removed; its branch ${w.branch} is kept. Recreate it to send turns.`,
};

/**
 * What's happening to the thread's worktree, and the ways in and out: Remove (git keeps a worktree with
 * uncommitted changes, which Remove anyway overrides) and Recreate, on the kept branch. A setup command
 * that failed shows its output.
 */
export const WorktreeBar = ({
  connection,
  threadId,
  worktree,
  busy,
}: {
  connection: Connection;
  threadId: ThreadId;
  worktree: WorktreeView;
  busy: boolean;
}) => {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const send = async (command: ClientCommand) => {
    setSending(true);
    const result = await connection.dispatch(command);
    setSending(false);
    setError(result.ok ? undefined : result.message);
  };
  const remove = (force: boolean) => send({ type: "thread.worktree.remove", commandId: uuid<CommandId>(), threadId, force });
  const { state, setup } = worktree;
  const message = error ?? said[state](worktree);
  const failedSetup = setup && !setup.passed && state === "ready" ? setup : undefined;
  if (!message && !failedSetup && (state !== "ready" || busy)) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-4 py-1.5 text-xs">
      {message && (
        <p role="status" className={`min-w-0 flex-1 [overflow-wrap:anywhere] ${error || worktree.error ? "text-error" : "text-muted"}`}>
          {message}
        </p>
      )}
      {failedSetup && (
        <details className="min-w-0 flex-1">
          <summary className="cursor-pointer text-error">
            Setup <code>{failedSetup.command}</code> failed{failedSetup.exitCode === null ? "" : ` (exit ${failedSetup.exitCode})`}
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono">{failedSetup.output}</pre>
        </details>
      )}
      <span className="ml-auto flex gap-1.5">
        {state === "ready" && !busy && (
          <button type="button" className="px-2 text-xs" disabled={sending} onClick={() => remove(worktree.error !== undefined)}>
            {worktree.error ? "Remove anyway" : "Remove worktree"}
          </button>
        )}
        {(state === "failed" || state === "removed") && (
          <button
            type="button"
            className="px-2 text-xs"
            disabled={sending}
            onClick={() => send({ type: "thread.worktree.add", commandId: uuid<CommandId>(), threadId })}
          >
            Recreate worktree
          </button>
        )}
      </span>
    </div>
  );
};
