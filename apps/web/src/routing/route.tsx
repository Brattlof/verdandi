import {
  type CommandId,
  describeRouteChange,
  Effort,
  type HarnessId,
  type Route,
  type RouteChange,
  type TaskId,
  type ThreadView,
} from "@verdandi/contracts";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { type Connection, type Dispatched, type Routed, uuid } from "../client.ts";
import type { LiveThread } from "../state.ts";

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

/**
 * The thread's route, and why: a routed task's reason, or that the user pinned it. Opening it shows the
 * routing trace and changes the route, applied from the next turn.
 */
export const RouteChip = ({ connection, thread }: { connection: Connection; thread: LiveThread }) => {
  const [open, setOpen] = useState(false);
  const summary = useRef<HTMLElement>(null);
  const close = () => {
    setOpen(false);
    summary.current?.focus();
  };
  const { harness, model, effort } = thread.route;
  // Unpinned with no task: the router hasn't picked yet, so the placeholder route means nothing.
  const auto = !thread.pinned && thread.task === null;
  const reason = thread.task?.reason;
  return (
    <details className="text-xs" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary
        ref={summary}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-0.5 hover:bg-hover [&::-webkit-details-marker]:hidden"
      >
        <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${thread.pinned ? "bg-muted" : "bg-accent"}`} />
        <span className="sr-only">Route: </span>
        <span className="shrink-0 font-mono font-medium">{auto ? "Auto" : `${harness} · ${model} · ${effort}`}</span>
        <span className="min-w-0 truncate text-muted">
          {thread.pinned ? "pinned by you" : auto ? "the router picks when you send" : (reason ?? "routed")}
        </span>
      </summary>
      {open && (
        <div className="mt-1.5 rounded-lg border border-line bg-card p-3">
          {/* A routed task's, or one its message pinned with `@name`; a pinned thread's needs no explaining. */}
          {thread.task && !thread.pinned && reason && <Why connection={connection} taskId={thread.task.taskId} reason={reason} />}
          <RouteForm connection={connection} thread={thread} close={close} />
          <ForgetMemory connection={connection} thread={thread} />
        </div>
      )}
    </details>
  );
};

/** A routed task's reason, and on request its trace: how each routing stage got there. */
const Why = ({ connection, taskId, reason }: { connection: Connection; taskId: TaskId; reason: string }) => {
  const [trace, setTrace] = useState<Routed>();
  const [loading, setLoading] = useState(false);
  const show = async () => {
    setLoading(true);
    setTrace(await connection.explain(taskId));
    setLoading(false);
  };
  return (
    <div className="mb-3">
      <p className="mb-1.5">{reason}</p>
      {!trace && (
        <button type="button" className="text-xs" onClick={show} disabled={loading}>
          Show routing trace
        </button>
      )}
      {trace?.ok === true && (
        <ol className="mt-1.5 flex list-decimal flex-col gap-0.5 pl-5 marker:text-muted" aria-label="Routing trace">
          {trace.decision.trace.map((t, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a stored trace never changes.
            <li key={i}>
              <strong className="font-mono font-semibold">{t.stage}</strong> {t.note}
            </li>
          ))}
        </ol>
      )}
      {trace?.ok === false && (
        <p role="alert" className="text-error">
          {trace.message}
        </p>
      )}
    </div>
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
  // Picking the route the router chose pins it; picking the pinned route again changes nothing.
  const pins = changed || !thread.pinned;
  const unpin = async () => {
    setSending(true);
    const result = await connection.dispatch({ type: "thread.route.unpin", commandId: uuid<CommandId>(), threadId: thread.threadId });
    setSending(false);
    if (result.ok) close();
    else setError(result.message);
  };
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pins || !to.model) return;
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
    <form className="flex flex-wrap items-end gap-x-3 gap-y-2" onSubmit={onSubmit}>
      <label className="flex flex-col gap-1 font-medium text-muted">
        Harness{" "}
        <select
          className="text-fg"
          value={draft.harness}
          disabled={thread.busy}
          onChange={(e) => setDraft({ ...draft, harness: e.target.value as HarnessId })}
        >
          {[...new Set([thread.route.harness, ...harnesses])].map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 font-medium text-muted">
        Model{" "}
        <input
          required
          className="font-mono text-fg"
          list={`${id}-models`}
          value={draft.model}
          onChange={(e) => setDraft({ ...draft, model: e.target.value })}
        />
        <datalist id={`${id}-models`}>
          {[...models].map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      <label className="flex flex-col gap-1 font-medium text-muted">
        Effort{" "}
        <select
          className="text-fg"
          value={draft.effort}
          onChange={(e) => setDraft({ ...draft, effort: e.target.value as Route["effort"] })}
        >
          {Effort.literals.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
      <p className="basis-full leading-relaxed text-muted">
        {thread.busy ? "Applies from the next turn. Change the harness when this one finishes." : "Applies from the next turn."}{" "}
        {thread.pinned ? "The router won't pick until you let it again." : "Picking a route pins it: the router stops picking."}
      </p>
      {cost && (
        <p id={`${id}-cost`} className="basis-full text-accent">
          {cost}
        </p>
      )}
      <div className="flex basis-full items-center justify-end gap-2">
        {error && (
          <span role="alert" className="mr-auto text-error">
            {error}
          </span>
        )}
        <button type="button" onClick={close}>
          Cancel
        </button>
        {thread.pinned && (
          <button type="button" onClick={unpin} disabled={sending}>
            Let the router pick
          </button>
        )}
        <button type="submit" disabled={sending || !pins || !to.model} aria-describedby={cost ? `${id}-cost` : undefined}>
          {changed ? "Change route" : "Pin this route"}
        </button>
      </div>
    </form>
  );
};

/**
 * Clears the project's routing memory (DESIGN §8.8): its next routed tasks go by the policy alone, until new
 * outcomes build memory again. The clear is recorded.
 */
const ForgetMemory = ({ connection, thread }: { connection: Connection; thread: LiveThread }) => {
  const [result, setResult] = useState<Dispatched>();
  const [sending, setSending] = useState(false);
  const forget = async () => {
    setSending(true);
    setResult(await connection.dispatch({ type: "routing.memory.clear", commandId: uuid<CommandId>(), threadId: thread.threadId }));
    setSending(false);
  };
  return (
    <p className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-muted">
      How this project's earlier tasks went can move the router's pick.
      <button type="button" className="text-xs" onClick={forget} disabled={sending}>
        Clear routing memory
      </button>
      {result?.ok === true && <span role="status">Cleared: the next routed tasks go by the policy alone.</span>}
      {result?.ok === false && (
        <span role="alert" className="text-error">
          {result.message}
        </span>
      )}
    </p>
  );
};

/** A line across the conversation with the note in its middle. */
const marker =
  "mx-auto flex max-w-[860px] items-center gap-3 px-4 py-2 text-xs text-muted before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line";

/** Where a thread's route changed, shown between the turns it came between. */
export const RouteMarkers = ({ changes }: { changes: readonly RouteChange[] | undefined }) =>
  changes?.map((c, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: route changes only ever append, so the index is stable.
    <p key={i} className={marker}>
      <span className="max-w-[80%] text-center">
        {describeRouteChange(c.from, c.to)
          ? `Route changed by you: ${describeRouteChange(c.from, c.to)}`
          : `Route pinned by you: ${c.to.model} · ${c.to.effort}`}{" "}
        · <time dateTime={c.at}>{new Date(c.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</time>
      </span>
    </p>
  ));
