import { BunSocket } from "@effect/platform-bun";
import { Api } from "@goldiloop/contracts";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

/** A typed client for a running goldiloopd. The socket lives as long as the caller's scope. */
export const connect = (options: { readonly port: number; readonly token: string }) =>
  Effect.gen(function* () {
    const url = `ws://127.0.0.1:${options.port}/rpc?token=${encodeURIComponent(options.token)}`;
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(Layer.provide(BunSocket.layerWebSocket(url)), Layer.provide(RpcSerialization.layerNdjson)),
    );
    return yield* RpcClient.make(Api).pipe(Effect.provideContext(protocol));
  });
