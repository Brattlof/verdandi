import { type AccessLevel, accessHelp, type CommandId } from "@verdandi/contracts";
import { useEffect, useId, useState } from "react";
import { type Connection, uuid } from "../client.ts";
import type { LiveThread } from "../state.ts";

const levels: { value: AccessLevel; label: string }[] = [
  { value: "ask", label: "Ask" },
  { value: "auto", label: "Auto" },
  { value: "full", label: "Full" },
];

/**
 * How much the thread's agent may do without asking (DESIGN §17): the profile's default from `approvals.yaml`, or one
 * the user picks for this thread, which applies from the agent's next action. A thread someone else can write in from
 * a chat app always asks.
 */
export const AccessSwitch = ({
  connection,
  thread,
  onError,
}: {
  connection: Connection;
  thread: LiveThread;
  onError: (message: string) => void;
}) => {
  const [profile, setProfile] = useState<AccessLevel>();
  const [sending, setSending] = useState(false);
  const id = useId();
  useEffect(() => {
    void connection.approvals().then((a) => a && setProfile(a.access));
  }, [connection]);
  const set = async (access: AccessLevel | null) => {
    setSending(true);
    const result = await connection.dispatch({
      type: "thread.access.set",
      commandId: uuid<CommandId>(),
      threadId: thread.threadId,
      access,
    });
    setSending(false);
    if (!result.ok) onError(result.message);
  };
  const label = (level: AccessLevel) => levels.find((l) => l.value === level)?.label;
  const level = thread.confined ? "ask" : (thread.access ?? profile);
  const note = thread.confined
    ? "Someone else can write in this thread from a chat app, so its agent always asks."
    : level && `${label(level)}: ${accessHelp[level]}.`;
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted" title={note}>
      Access{" "}
      <select
        className="text-xs text-fg"
        value={thread.access ?? ""}
        disabled={thread.confined || sending}
        aria-describedby={`${id}-note`}
        onChange={(e) => void set(levels.find((l) => l.value === e.target.value)?.value ?? null)}
      >
        <option value="">Default{profile ? ` (${label(profile)})` : ""}</option>
        {levels.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
      </select>
      <span id={`${id}-note`} className="sr-only">
        {note}
      </span>
    </label>
  );
};
