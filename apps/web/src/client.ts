import { Api, type ClientCommand, CommandRejected } from "@verdandi/contracts";
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

export const uuid = <T>() => crypto.randomUUID() as T;

const makeClient = RpcClient.make(Api);
class Client extends Context.Service<Client, Effect.Success<typeof makeClient>>()("verdandi/web/Client") {}
type Rpc = Client["Service"];

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
  /** The command's rejection, when verdandid refused it; a lost connection also sets `lost`. */
  const failure = (cause: Cause.Cause<unknown>) => {
    const error = Cause.squash(cause);
    if (error instanceof CommandRejected) return error;
    lost.set(true);
    return undefined;
  };

  const dispatch = async (command: ClientCommand): Promise<Dispatched> => {
    const exit = await run((rpc) => rpc.CommandDispatch(command));
    if (Exit.isSuccess(exit)) return { ok: true };
    const rejected = failure(exit.cause);
    return rejected ? { ok: false, reason: rejected.reason, message: rejected.message } : disconnected;
  };

  /**
   * Follows a feed until the returned function is called. It never stops the stream itself: it asks
   * the server to end it (ADR 0008), once the first message shows the server has registered it.
   */
  const follow = <A, E>(
    open: (rpc: Rpc, subscriptionId: string) => Stream.Stream<A, E>,
    onMessage: (message: A) => void,
    onRejected: (message: string) => void,
  ) => {
    const subscriptionId = crypto.randomUUID();
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
      const rejected = Exit.isFailure(exit) ? failure(exit.cause) : undefined;
      if (rejected) onRejected(rejected.message);
    });
    return () => {
      void started.promise.then(() => (ended ? undefined : run((rpc) => rpc.Unsubscribe({ subscriptionId }))));
    };
  };

  return { dispatch, follow, lost };
};
export type Connection = ReturnType<typeof connect>;
