import type { CommandId } from "@verdandi/contracts";
import { useCallback, useEffect, useState } from "react";
import { type Connection, uuid } from "../client.ts";

type State = Awaited<ReturnType<Connection["approvals"]>>;

/**
 * Whether smart approvals rate the native agent's terminal commands (DESIGN §17), with one click to turn them off, and
 * back on. Shows nothing unless the profile's `approvals.yaml` enables them. Fetched when the composer opens.
 */
export const SmartApprovals = ({ connection }: { connection: Connection }) => {
  const [state, setState] = useState<State>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const refresh = useCallback(() => connection.approvals().then(setState), [connection]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!state?.enabled) return null;
  const turn = async (on: boolean) => {
    setBusy(true);
    const result = await connection.dispatch({ type: "approvals.smart.set", commandId: uuid<CommandId>(), on });
    setBusy(false);
    setError(result.ok ? undefined : result.message);
    if (result.ok) await refresh();
  };
  return (
    <section aria-label="Smart approvals" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      <span>
        {state.on ? "Smart approvals on: commands they rate safe run without asking." : "Smart approvals off: every command asks."}
      </span>
      <button type="button" className="px-2 text-xs" disabled={busy} onClick={() => turn(!state.on)}>
        {state.on ? "Turn off" : "Turn back on"}
      </button>
      {error && (
        <span role="alert" className="text-error">
          {error}
        </span>
      )}
    </section>
  );
};
