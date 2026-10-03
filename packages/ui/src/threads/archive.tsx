import type { CommandId, ThreadId } from "@verdandi/contracts";
import { useState } from "react";
import { type Connection, uuid } from "../client.ts";

/**
 * Archives a thread, or unarchives an archived one. Archiving only hides it from the thread lists:
 * nothing is deleted, and its costs still count. A thread with a running turn can't be archived.
 */
export const ArchiveButton = ({
  connection,
  threadId,
  archived,
  title,
  className = "",
  onError,
}: {
  connection: Connection;
  threadId: ThreadId;
  archived: boolean;
  /** Names the thread for screen readers, where the button sits in a list of threads. */
  title?: string;
  className?: string;
  onError: (message: string | undefined) => void;
}) => {
  const [sending, setSending] = useState(false);
  const toggle = async () => {
    setSending(true);
    const result = await connection.dispatch({
      type: archived ? "thread.unarchive" : "thread.archive",
      commandId: uuid<CommandId>(),
      threadId,
    });
    setSending(false);
    onError(result.ok ? undefined : result.message);
  };
  const label = archived ? "Unarchive" : "Archive";
  return (
    <button
      type="button"
      className={`px-2 text-xs ${className}`}
      disabled={sending}
      onClick={toggle}
      aria-label={title === undefined ? undefined : `${label} ${title}`}
    >
      {label}
    </button>
  );
};
