import { type CommandId, capPeriodNow, capReached, describeSpendCap, formatUsd, type SpendCap } from "@verdandi/contracts";
import { useCallback, useEffect, useState } from "react";
import { type Connection, uuid } from "./client.ts";
import type { LiveThread } from "./state.ts";

type Caps = Awaited<ReturnType<Connection["spendCaps"]>>;

/**
 * How close the thread's project and profile are to their metered spend caps (DESIGN §8.9), with one
 * click to raise a reached cap for the rest of its period. Fetched when the thread opens and after each
 * turn ends, and again after a send was `rejected` by a cap: another thread may have reached it. Shows
 * nothing when no caps are set.
 */
export const SpendCaps = ({ connection, thread, rejected }: { connection: Connection; thread: LiveThread; rejected: number }) => {
  const [caps, setCaps] = useState<Caps>();
  const [error, setError] = useState<string>();
  const [raising, setRaising] = useState(false);
  const finished = thread.turns.filter((t) => t.status !== "running").length;
  const { threadId } = thread;
  const refresh = useCallback(() => connection.spendCaps(threadId).then(setCaps), [connection, threadId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `finished` and `rejected` are the triggers, not inputs.
  useEffect(() => {
    void refresh();
  }, [refresh, finished, rejected]);
  if (!caps) return null;
  if (!caps.ok)
    return (
      <p role="alert" className="text-xs text-error">
        {caps.message}
      </p>
    );
  if (caps.caps.length === 0) return null;
  const raise = async (cap: SpendCap) => {
    setRaising(true);
    const result = await connection.dispatch({
      type: "spend.cap.raise",
      commandId: uuid<CommandId>(),
      threadId,
      scope: cap.scope,
      period: cap.period,
    });
    setRaising(false);
    setError(result.ok ? undefined : result.message);
    if (result.ok) await refresh();
  };
  return (
    <section aria-label="Spend caps" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted tabular-nums">
      {caps.caps.map((cap) => (
        <span key={`${cap.scope}-${cap.period}`} className={capReached(cap) ? "text-error" : undefined}>
          {describeSpendCap(cap)}
          {capReached(cap) && (
            <button type="button" className="ml-2 px-2 text-xs" disabled={raising} onClick={() => raise(cap)}>
              Raise to {formatUsd(cap.limitUsd + cap.baseUsd)} for {capPeriodNow(cap.period)}
            </button>
          )}
        </span>
      ))}
      {error && (
        <span role="alert" className="text-error">
          {error}
        </span>
      )}
    </section>
  );
};
