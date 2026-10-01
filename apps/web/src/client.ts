import {
  Api,
  type ClientCommand,
  CommandRejected,
  DiffUnavailable,
  type DiffView,
  type HarnessId,
  type InteractionMode,
  type MemoryView,
  type RouteDecision,
  type RouteTarget,
  RoutingUnavailable,
  type SessionHit,
  type SessionQuery,
  type SpendCap,
  SpendCapsUnavailable,
  type TaskId,
  type TerminalId,
  TerminalUnavailable,
  type ThreadId,
  type TurnId,
  type UsageFilter,
  type UsageReport,
} from "@verdandi/contracts";
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import { useSyncExternalStore } from "react";

/** A value React reads with `useSyncExternalStore`. Listeners run at most once per frame, so a burst of deltas renders once. */
export const createStore = <S>(initial: S) => {
  let state = initial;
  let scheduled = false;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next: S) => {
      if (next === state) return;
      state = next;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        for (const listener of listeners) listener();
      });
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
};
export type Store<S> = ReturnType<typeof createStore<S>>;
export const useStore = <S>(store: Store<S>) => useSyncExternalStore(store.subscribe, store.get);

/**
 * A random v4 UUID. Built from `crypto.getRandomValues`, since browsers drop `crypto.randomUUID` outside secure
 * contexts, and a page opened from another device on the local network (`verdandi start --host`) is one.
 */
export const uuid = <T = string>() => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as T;
};

const makeClient = RpcClient.make(Api);
class Client extends Context.Service<Client, Effect.Success<typeof makeClient>>()("verdandi/web/Client") {}
type Rpc = Client["Service"];

/** A routing decision, or why verdandid couldn't route. */
export type Routed = { readonly ok: true; readonly decision: RouteDecision } | { readonly ok: false; readonly message: string };

export type Dispatched =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CommandRejected["reason"] | "Disconnected"; readonly message: string };

const disconnected = { ok: false, reason: "Disconnected", message: "Lost the connection to verdandid." } as const;

/**
 * The page's connection to verdandid, over the same token-protected WebSocket RPC as `verdandi chat`.
 * `lost` turns true once a call fails for any reason but a rejected command; the page never
 * pretends to be connected after that.
 */
export const connect = (token: string) => {
  const url = `ws://${location.host}/rpc?token=${encodeURIComponent(token)}`;
  const runtime = ManagedRuntime.make(
    Layer.effect(Client)(makeClient).pipe(
      Layer.provide(RpcClient.layerProtocolSocket()),
      Layer.provide(Socket.layerWebSocket(url)),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provide(RpcSerialization.layerNdjson),
    ),
  );
  const lost = createStore(false);
  const run = <A, E>(f: (rpc: Rpc) => Effect.Effect<A, E>) =>
    runtime.runPromiseExit(
      Effect.gen(function* () {
        return yield* f(yield* Client);
      }),
    );
  /** The error verdandid answered with, when it is one of `known`; anything else sets `lost`. */
  const failure = <E>(cause: Cause.Cause<unknown>, known: abstract new (...args: never[]) => E) => {
    const error = Cause.squash(cause);
    if (error instanceof known) return error;
    lost.set(true);
    return undefined;
  };

  const dispatch = async (command: ClientCommand): Promise<Dispatched> => {
    const exit = await run((rpc) => rpc.CommandDispatch(command));
    if (Exit.isSuccess(exit)) return { ok: true };
    const rejected = failure(exit.cause, CommandRejected);
    return rejected ? { ok: false, reason: rejected.reason, message: rejected.message } : disconnected;
  };

  /** What `turnId` changed, or everything since the thread's first turn. A `DiffUnavailable` message names the fix. */
  const diff = async (
    threadId: ThreadId,
    turnId: TurnId | undefined,
  ): Promise<{ readonly ok: true; readonly view: DiffView } | { readonly ok: false; readonly message: string }> => {
    const exit = await run((rpc) => rpc.DiffGet(turnId === undefined ? { threadId } : { threadId, turnId }));
    if (Exit.isSuccess(exit)) return { ok: true, view: exit.value };
    const unavailable = failure(exit.cause, DiffUnavailable);
    return unavailable ? { ok: false, message: unavailable.message } : disconnected;
  };

  const routed = (exit: Exit.Exit<RouteDecision, unknown>): Routed => {
    if (Exit.isSuccess(exit)) return { ok: true, decision: exit.value };
    const unavailable = failure(exit.cause, RoutingUnavailable);
    return unavailable ? { ok: false, message: unavailable.message } : disconnected;
  };
  /** A task's routing decision, with its trace. */
  const explain = async (taskId: TaskId) => routed(await run((rpc) => rpc.RoutingExplain({ taskId })));
  /** What the router would pick if `text`, with `images` attached, started a new task in the thread. Stores nothing. */
  const simulate = async (threadId: ThreadId, text: string, mode: InteractionMode, images: number) =>
    routed(await run((rpc) => rpc.RoutingSimulate({ threadId, text, mode, ...(images > 0 && { images }) })));

  /**
   * An object URL for a stored attachment's bytes, fetched once per page with the token in a header, never the
   * URL. Undefined when verdandid can't serve it.
   */
  const attachments = new Map<string, Promise<string | undefined>>();
  const attachmentUrl = (id: string) => {
    let url = attachments.get(id);
    if (!url) {
      url = fetch(`/attachments/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.blob() : undefined))
        .then(
          (blob) => blob && URL.createObjectURL(blob),
          () => undefined,
        );
      attachments.set(id, url);
    }
    return url;
  };

  /** A terminal call's answer; a `TerminalUnavailable` message names the fix. */
  const terminalCall = async <A>(
    call: (rpc: Rpc) => Effect.Effect<A, unknown>,
  ): Promise<{ readonly ok: true; readonly value: A } | { readonly ok: false; readonly message: string }> => {
    const exit = await run(call);
    if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
    const unavailable = failure(exit.cause, TerminalUnavailable);
    return unavailable ? { ok: false, message: unavailable.message } : disconnected;
  };
  /** The thread's terminals, which outlive the page: open, list, type, resize and close them. Their output is a feed. */
  const terminals = {
    open: (threadId: ThreadId, cols: number, rows: number) => terminalCall((rpc) => rpc.TerminalOpen({ threadId, cols, rows })),
    list: (threadId: ThreadId) => terminalCall((rpc) => rpc.TerminalList({ threadId })),
    write: (terminalId: TerminalId, data: string) => terminalCall((rpc) => rpc.TerminalWrite({ terminalId, data })),
    resize: (terminalId: TerminalId, cols: number, rows: number) => terminalCall((rpc) => rpc.TerminalResize({ terminalId, cols, rows })),
    close: (terminalId: TerminalId) => terminalCall((rpc) => rpc.TerminalClose({ terminalId })),
  };

  /** The spend caps over the thread's project and profile, and what each has spent this period. */
  const spendCaps = async (
    threadId: ThreadId,
  ): Promise<{ readonly ok: true; readonly caps: readonly SpendCap[] } | { readonly ok: false; readonly message: string }> => {
    const exit = await run((rpc) => rpc.SpendCapsGet({ threadId }));
    if (Exit.isSuccess(exit)) return { ok: true, caps: exit.value };
    const unavailable = failure(exit.cause, SpendCapsUnavailable);
    return unavailable ? { ok: false, message: unavailable.message } : disconnected;
  };

  /** The spend dashboard's totals; undefined once the connection is lost. */
  /** What Verdandi remembers for the thread's user and project; undefined when it can't be read. */
  const memory = async (threadId: ThreadId): Promise<MemoryView | undefined> => {
    const exit = await run((rpc) => rpc.MemoryList({ threadId }));
    if (Exit.isSuccess(exit)) return exit.value;
    failure(exit.cause, CommandRejected);
    return undefined;
  };

  /** Past sessions' messages containing `query`, newest first. Under 3 characters, none. */
  const search = async (query: SessionQuery): Promise<readonly SessionHit[] | undefined> => {
    const exit = await run((rpc) => rpc.SessionSearch(query));
    if (Exit.isSuccess(exit)) return exit.value;
    lost.set(true); // it has no errors of its own
    return undefined;
  };

  const usage = async (filter: UsageFilter): Promise<UsageReport | undefined> => {
    const exit = await run((rpc) => rpc.UsageQuery(filter));
    if (Exit.isSuccess(exit)) return exit.value;
    lost.set(true); // it has no errors of its own
    return undefined;
  };

  /**
   * Follows a feed until the returned function is called. It never stops the stream itself: it asks
   * the server to end it (ADR 0008), once the first message shows the server has registered it.
   */
  const follow = <A, E>(
    open: (rpc: Rpc, subscriptionId: string) => Stream.Stream<A, E>,
    onMessage: (message: A) => void,
    onRejected: (message: string) => void,
    /** The error class whose message `onRejected` gets; any other failure sets `lost`. */
    known: abstract new (...args: never[]) => { readonly message: string } = CommandRejected,
  ) => {
    const subscriptionId = uuid();
    const started = Promise.withResolvers<void>();
    let ended = false;
    void run((rpc) =>
      open(rpc, subscriptionId).pipe(
        Stream.runForEach((message) =>
          Effect.sync(() => {
            started.resolve();
            onMessage(message);
          }),
        ),
      ),
    ).then((exit) => {
      ended = true;
      started.resolve();
      const rejected = Exit.isFailure(exit) ? failure(exit.cause, known) : undefined;
      if (rejected) onRejected(rejected.message);
    });
    return () => {
      void started.promise.then(() => (ended ? undefined : run((rpc) => rpc.Unsubscribe({ subscriptionId }))));
    };
  };

  /** The harnesses verdandid runs. Asked once: they are fixed while it runs. */
  let harnessList: Promise<readonly HarnessId[]> | undefined;
  const harnesses = () =>
    (harnessList ??= run((rpc) => rpc.HarnessesList()).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      lost.set(true); // it has no errors of its own
      return [];
    }));

  /** The models a message can pin its task to with a leading `@name`. Asked once: they are fixed while verdandid runs. */
  let modelList: Promise<readonly RouteTarget[]> | undefined;
  const models = () =>
    (modelList ??= run((rpc) => rpc.ModelsList()).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      lost.set(true); // it has no errors of its own
      return [];
    }));

  return { dispatch, diff, explain, simulate, attachmentUrl, spendCaps, usage, search, memory, terminals, follow, harnesses, models, lost };
};
export type Connection = ReturnType<typeof connect>;
