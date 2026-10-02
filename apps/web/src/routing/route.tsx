import {
  type CatalogModel,
  type CommandId,
  describeRouteChange,
  Effort,
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
 * (ADR 0002); a new harness starts a fresh session. A thread with no session yet has nothing to lose.
 */
export const switchCost = (thread: Pick<ThreadView, "route" | "sessionId" | "turns">, to: Route) => {
  const from = thread.route;
  if (thread.sessionId === null) return undefined;
  if (from.harness !== to.harness) return `${to.harness} starts a fresh session: the agent won't see this thread's earlier turns.`;
  const cold = from.model !== to.model || (from.effort !== to.effort && to.harness === "claude-code");
  if (!cold) return undefined;
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

/** A model the picker offers: the catalog's, or the thread's own when the catalog doesn't list it. */
type Choice = Pick<CatalogModel, "harness" | "model" | "efforts"> & { readonly access?: CatalogModel["access"] };
const key = (r: Pick<Route, "harness" | "model">) => `${r.harness}/${r.model}`;

const RouteForm = ({ connection, thread, close }: { connection: Connection; thread: LiveThread; close: () => void }) => {
  // Only the user's edits are state, so the form follows the thread's route as the feed updates it.
  const [edits, setEdits] = useState<Partial<Route>>({});
  const draft = { ...thread.route, ...edits };
  const [models, setModels] = useState<readonly CatalogModel[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const id = useId();
  useEffect(() => {
    void connection.models().then(setModels);
  }, [connection]);
  // Unpinned with no task, the thread's route is a placeholder: nothing is current yet.
  const current = !thread.pinned && thread.task === null ? undefined : key(thread.route);
  // A model picked with `verdandi chat --model` may not be in the catalog; it stays a choice.
  const choices: readonly Choice[] =
    current === undefined || models.some((m) => key(m) === current)
      ? models
      : [{ harness: thread.route.harness, model: thread.route.model, efforts: Effort.literals }, ...models];
  const selected = choices.find((m) => key(m) === key(draft)) ?? choices[0];
  const efforts = selected?.efforts ?? Effort.literals;
  const to: Route = selected ? { ...draft, harness: selected.harness, model: selected.model } : draft;
  const pick = (value: string) => {
    const m = choices.find((c) => key(c) === value);
    if (!m) return;
    const effort = m.efforts.length === 0 || m.efforts.includes(draft.effort) ? draft.effort : (m.efforts[0] ?? draft.effort);
    setEdits({ ...edits, harness: m.harness, model: m.model, effort });
  };
  const changed = current !== undefined && describeRouteChange(thread.route, to) !== "";
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
    if (!pins || !selected) return;
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
        Model{" "}
        <select className="font-mono text-fg" value={key(to)} onChange={(e) => pick(e.target.value)}>
          {[...Map.groupBy(choices, (m) => m.harness)].map(([harness, group]) => (
            // A busy thread keeps its harness until the turn ends.
            <optgroup key={harness} label={harness} disabled={thread.busy && harness !== thread.route.harness}>
              {group.map((m) => (
                <option key={key(m)} value={key(m)}>
                  {m.model} · {m.access ?? "not in the catalog"}
                  {key(m) === current ? " (current)" : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 font-medium text-muted">
        Effort{" "}
        <select
          className="text-fg"
          value={to.effort}
          disabled={efforts.length === 0}
          aria-describedby={efforts.length === 0 ? `${id}-no-effort` : undefined}
          onChange={(e) => setEdits({ ...edits, effort: e.target.value as Route["effort"] })}
        >
          {(efforts.length > 0 ? efforts : [to.effort]).map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
      {efforts.length === 0 && (
        <p id={`${id}-no-effort`} className="basis-full text-muted">
          {to.model} takes no effort level.
        </p>
      )}
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
        <button type="submit" disabled={sending || !pins || !selected} aria-describedby={cost ? `${id}-cost` : undefined}>
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
