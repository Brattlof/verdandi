import {
  Api,
  type CatalogModel,
  type ClientCommand,
  CommandRejected,
  DevicesUnavailable,
  DiffUnavailable,
  type DiffView,
  FolderPickUnavailable,
  type InteractionMode,
  type MemoryView,
  type RouteDecision,
  RoutingUnavailable,
  type SessionHit,
  type SessionQuery,
  type SkillHistoryEntry,
  type SkillsView,
  type SpendCap,
  SpendCapsUnavailable,
  type TaskId,
  type TerminalId,
  TerminalUnavailable,
  type ThreadId,
  type TrustedCommands,
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
 * contexts, and a page opened from another device on the local network (`verdandi web --host`) is one.
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

/** Where the UI reaches the agent, and what it should know about the host that shows it (the web server, later the desktop app). */
export type Endpoint = {
  /** The host's address, e.g. `http://127.0.0.1:4780`: the RPC WebSocket is at `/rpc`, attachments at `/attachments/<id>`. */
  readonly base: string;
  /**
   * The page's token: one the host made for this page, which it swaps for the agent's (the page never holds that), or,
   * with `device`, the device token this device got when it paired (ADR 0028), which the agent checks itself.
   */
  readonly token: string;
  readonly device?: true;
  /** Whether the agent runs on the machine showing the page, so its OS folder dialog reaches the user. */
  readonly sameMachine: boolean;
  /** What to do once the connection is lost, e.g. "If verdandid restarted, run `verdandi web` again." */
  readonly reconnectHint: string;
};

/**
 * The page's connection to verdandid, over the same token-protected WebSocket RPC as `verdandi chat`, through its host.
 * `lost` turns true once a call fails for any reason but a rejected command; the page never
 * pretends to be connected after that.
 */
export const connect = (endpoint: Endpoint) => {
  const { base, token } = endpoint;
  const url = `${base.replace(/^http/, "ws")}/rpc?${endpoint.device ? "device" : "token"}=${encodeURIComponent(token)}`;
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

  /** The folder the user chose in the OS dialog on verdandid's machine, or null when they cancelled. */
  const pickFolder = async (): Promise<
    { readonly ok: true; readonly path: string | null } | { readonly ok: false; readonly message: string }
  > => {
    const exit = await run((rpc) => rpc.FolderPick());
    if (Exit.isSuccess(exit)) return { ok: true, path: exit.value };
    const unavailable = failure(exit.cause, FolderPickUnavailable);
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
      url = fetch(`${base}/attachments/${encodeURIComponent(id)}`, {
        headers: { authorization: `${endpoint.device ? "Device" : "Bearer"} ${token}` },
      })
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

  /** What Verdandi remembers for the thread's user and project; undefined when it can't be read. */
  const memory = async (threadId: ThreadId): Promise<MemoryView | undefined> => {
    const exit = await run((rpc) => rpc.MemoryList({ threadId }));
    if (Exit.isSuccess(exit)) return exit.value;
    failure(exit.cause, CommandRejected);
    return undefined;
  };

  /** The profile's skills and those in its extra folders; undefined when the connection is lost. */
  const skills = async (): Promise<SkillsView | undefined> => {
    const exit = await run((rpc) => rpc.SkillsList());
    if (Exit.isSuccess(exit)) return exit.value;
    lost.set(true); // it has no errors of its own
    return undefined;
  };

  /** The changes written to profile skill `skill`, newest first; undefined when the connection is lost. */
  const skillHistory = async (skill: string): Promise<readonly SkillHistoryEntry[] | undefined> => {
    const exit = await run((rpc) => rpc.SkillHistoryGet({ skill }));
    if (Exit.isSuccess(exit)) return exit.value;
    lost.set(true); // it has no errors of its own
    return undefined;
  };

  /** The command lists the user trusted, in every project, newest first; undefined when the connection is lost. */
  const trusted = async (): Promise<readonly TrustedCommands[] | undefined> => {
    const exit = await run((rpc) => rpc.TrustedCommandsList({}));
    if (Exit.isSuccess(exit)) return exit.value;
    lost.set(true); // it has no errors of its own
    return undefined;
  };

  /** Past sessions' messages containing `query`, newest first. Under 3 characters, none. */
  const search = async (query: SessionQuery): Promise<readonly SessionHit[] | undefined> => {
    const exit = await run((rpc) => rpc.SessionSearch(query));
    if (Exit.isSuccess(exit)) return exit.value;
    lost.set(true); // it has no errors of its own
    return undefined;
  };

  /** The spend dashboard's totals; undefined once the connection is lost. */
  const usage = async (filter: UsageFilter): Promise<UsageReport | undefined> => {
    const exit = await run((rpc) => rpc.UsageQuery(filter));
    if (Exit.isSuccess(exit)) return exit.value;
    lost.set(true); // it has no errors of its own
    return undefined;
  };

  /**
   * Follows a feed until the returned function is called. It never stops the stream itself: it asks
   * the server to end it (ADR 0008), once the first message shows the server has registered it.
   * A handler that returns a promise holds the feed until it settles, so the server sends no faster than it's taken in.
   */
  const follow = <A, E>(
    open: (rpc: Rpc, subscriptionId: string) => Stream.Stream<A, E>,
    onMessage: (message: A) => void | Promise<void>,
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
          Effect.suspend(() => {
            started.resolve();
            const handled = onMessage(message);
            return handled ? Effect.promise(() => handled) : Effect.void;
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

  /** Pairs the device that raised `requestId`, or denies it; a `DevicesUnavailable` message says why not. */
  const answerPairing = async (requestId: string, approve: boolean): Promise<Dispatched> => {
    const exit = await run((rpc) => (approve ? Effect.asVoid(rpc.DeviceApprove({ requestId })) : rpc.DeviceDeny({ requestId })));
    if (Exit.isSuccess(exit)) return { ok: true };
    const unavailable = failure(exit.cause, DevicesUnavailable);
    return unavailable ? { ok: false, reason: "DeviceNotFound", message: unavailable.message } : disconnected;
  };

  /**
   * The catalog's models on the harnesses verdandid runs: what a leading `@name` pins and the route picker offers.
   * Asked once: they are fixed while verdandid runs.
   */
  let modelList: Promise<readonly CatalogModel[]> | undefined;
  const models = () =>
    (modelList ??= run((rpc) => rpc.ModelsList()).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      lost.set(true); // it has no errors of its own
      return [];
    }));

  return {
    dispatch,
    diff,
    pickFolder,
    explain,
    simulate,
    attachmentUrl,
    spendCaps,
    usage,
    search,
    memory,
    skills,
    skillHistory,
    trusted,
    terminals,
    follow,
    answerPairing,
    models,
    lost,
    endpoint,
  };
};
export type Connection = ReturnType<typeof connect>;
