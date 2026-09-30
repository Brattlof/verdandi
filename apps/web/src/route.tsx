import {
  type CommandId,
  describeRouteChange,
  Effort,
  type HarnessId,
  type Route,
  type RouteChange,
  type ThreadView,
} from "@verdandi/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { type Connection, uuid } from "./client.ts";
import type { LiveThread } from "./state.ts";

/**
 * What switching `thread` to `to` costs beyond the usual turn, or undefined when nothing extra.
 * A warm session loses its cache on a model change, and on Claude Code on an effort change too
 * (ADR 0002); a new harness starts a fresh session.
 */
export const switchCost = (thread: Pick<ThreadView, "route" | "sessionId" | "turns">, to: Route) => {
  const from = thread.route;
  if (from.harness !== to.harness) return `${to.harness} starts a fresh session: the agent won't see this thread's earlier turns.`;
  const cold = from.model !== to.model || (from.effort !== to.effort && to.harness === "claude-code");
  if (!cold || thread.sessionId === null) return undefined;
  const turns = thread.turns.length;
  return `The next turn is a cold cache write of the whole conversation (${turns} turn${turns === 1 ? "" : "s"} so far), so it costs more than a usual turn.`;
};

/** The thread's route. Opening it changes harness, model and effort, applied from the next turn. */
export const RouteChip = ({ connection, thread }: { connection: Connection; thread: LiveThread }) => {
  const [open, setOpen] = useState(false);
  const summary = useRef<HTMLElement>(null);
  const close = () => {
    setOpen(false);
    summary.current?.focus();
  };
  const { harness, model, effort } = thread.route;
  return (
    <details className="route" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary ref={summary}>
        <span className="sr-only">Route: </span>
        {harness} · {model} · {effort}
      </summary>
      {open && <RouteForm connection={connection} thread={thread} close={close} />}
    </details>
  );
};

const RouteForm = ({ connection, thread, close }: { connection: Connection; thread: LiveThread; close: () => void }) => {
  const [draft, setDraft] = useState(thread.route);
  const [harnesses, setHarnesses] = useState<readonly HarnessId[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  useEffect(() => {
    void connection.harnesses().then(setHarnesses);
  }, [connection]);
  // ponytail: models this thread has used, until the model catalog (DESIGN §20 packages/models) lists them per harness.
  const models = new Set([
    thread.route.model,
    ...thread.routeChanges.map((c) => c.from.model),
    ...thread.turns.flatMap((t) => t.usage.map((u) => u.model)),
  ]);
  const to = { ...draft, model: draft.model.trim() };
  const changed = describeRouteChange(thread.route, to) !== "";
  const cost = changed ? switchCost(thread, to) : undefined;
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed || !to.model) return;
    setSending(true);
    const result = await connection.dispatch({
      type: "thread.route.set",
      commandId: uuid<CommandId>(),
      threadId: thread.threadId,
      route: to,
    });
    setSending(false);
    if (result.ok) close();
    else setError(result.message);
  };
  return (
    <form className="route-form" onSubmit={onSubmit}>
      <label>
        Harness{" "}
        <select value={draft.harness} disabled={thread.busy} onChange={(e) => setDraft({ ...draft, harness: e.target.value as HarnessId })}>
          {[...new Set([thread.route.harness, ...harnesses])].map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
      </label>
      <label>
        Model <input required list={`${id}-models`} value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
        <datalist id={`${id}-models`}>
          {[...models].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      <label>
        Effort{" "}
        <select value={draft.effort} onChange={(e) => setDraft({ ...draft, effort: e.target.value as Route["effort"] })}>
          {Effort.literals.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        {thread.busy ? "Applies from the next turn. Change the harness when this one finishes." : "Applies from the next turn."}
      </p>
      {cost && (
        <p id={`${id}-cost`} className="cost">
          {cost}
        </p>
      )}
      <div className="actions">
        {error && (
          <span role="alert" className="error">
            {error}
          </span>
        )}
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button type="submit" disabled={sending || !changed || !to.model} aria-describedby={cost ? `${id}-cost` : undefined}>
          Change route
        </button>
      </div>
    </form>
  );
};

/** Where a thread's route changed, shown between the turns it came between. */
export const RouteMarkers = ({ changes }: { changes: readonly RouteChange[] | undefined }) =>
  changes?.map((c, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: route changes only ever append, so the index is stable.
    <p key={i} className="route-change">
      Route changed by you: {describeRouteChange(c.from, c.to)} ·{" "}
      <time dateTime={c.at}>{new Date(c.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</time>
    </p>
  ));
