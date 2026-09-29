import { randomBytes, timingSafeEqual } from "node:crypto";
import { BunHttpServer } from "@effect/platform-bun";
import { Api, type HarnessAdapter, type HarnessId } from "@goldiloop/contracts";
import { Context, Deferred, Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { AppLayer } from "../orchestration/app.ts";
import { Engine } from "../orchestration/engine.ts";

/** Where the running server listens, and the token clients must present. */
export class ServerInfo extends Context.Service<ServerInfo, { readonly port: number; readonly token: string }>()("goldiloop/ServerInfo") {}

const Handlers = Api.toLayer(
  Effect.gen(function* () {
    const engine = yield* Engine;
    const subscriptions = new Map<string, Deferred.Deferred<void>>();
    return {
      CommandDispatch: (command) => engine.dispatch(command).pipe(Effect.catchTag("SqlError", Effect.die)),
      ThreadSubscribe: ({ threadId, subscriptionId }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const stop = yield* Deferred.make<void>();
            subscriptions.set(subscriptionId, stop);
            return engine.feed(threadId).pipe(
              // The server ends the feed; clients never stop it early (ADR 0008).
              Stream.haltWhen(Deferred.await(stop)),
              Stream.catchTag("SqlError", Stream.die),
              Stream.ensuring(Effect.sync(() => subscriptions.delete(subscriptionId))),
            );
          }),
        ),
      ThreadUnsubscribe: ({ subscriptionId }) => {
        const stop = subscriptions.get(subscriptionId);
        return stop ? Deferred.succeed(stop, undefined).pipe(Effect.asVoid) : Effect.void;
      },
    };
  }),
);

const sameToken = (given: string | null, token: string) =>
  given !== null && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));

/** The WebSocket RPC protocol at /rpc, refusing upgrades without the profile's token. */
const ProtocolWithToken = (token: string) =>
  Layer.effect(RpcServer.Protocol)(
    Effect.gen(function* () {
      const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add(
        "GET",
        "/rpc",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const given = new URL(request.url, "http://localhost").searchParams.get("token");
          if (!sameToken(given, token)) {
            return HttpServerResponse.text("Missing or wrong token. Clients read it from server.json in the Goldiloop home.", {
              status: 401,
            });
          }
          return yield* httpEffect;
        }),
      );
      return protocol;
    }),
  );

/** goldiloopd: the core plus a token-protected WebSocket API on 127.0.0.1. Port 0 picks a free port. */
export const ServerLayer = (
  home: string,
  harnesses: Partial<Record<HarnessId, HarnessAdapter>>,
  options: { readonly port?: number } = {},
) => {
  const token = randomBytes(32).toString("hex");
  const rpc = RpcServer.layer(Api).pipe(
    Layer.provide(Handlers),
    Layer.provide(ProtocolWithToken(token)),
    Layer.provide(RpcSerialization.layerNdjson),
  );
  const http = HttpRouter.serve(rpc).pipe(
    Layer.provideMerge(
      BunHttpServer.layer({
        hostname: "127.0.0.1",
        port: options.port ?? 0,
        // Bun's server.stop() waits for open WebSockets. The default "preemptive" stop runs before the
        // RPC layer closes its client sockets, so a connected `goldiloop chat` blocked shutdown. Without
        // it, the RPC layer closes the sockets first and the final stop() resolves.
        disablePreemptiveShutdown: true,
      }),
    ),
  );
  const info = Layer.effect(ServerInfo)(
    Effect.gen(function* () {
      const { address } = yield* HttpServer.HttpServer;
      if (address._tag === "UnixPathAddress") return yield* Effect.die("goldiloopd must listen on TCP");
      return { port: address.port, token };
    }),
  );
  return info.pipe(Layer.provideMerge(http), Layer.provideMerge(AppLayer(home, harnesses)));
};
