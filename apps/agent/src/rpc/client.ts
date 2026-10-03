import { BunSocket } from "@effect/platform-bun";
import { Api } from "@verdandi/contracts";
import { Effect, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

/**
 * A typed client for a running verdandid, holding the profile's token or, with `device`, a paired device's (ADR 0028).
 * The socket lives as long as the caller's scope.
 */
export const connect = (options: { readonly port: number; readonly token: string; readonly device?: true }) =>
  Effect.gen(function* () {
    const url = `ws://127.0.0.1:${options.port}/rpc?${options.device ? "device" : "token"}=${encodeURIComponent(options.token)}`;
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(Layer.provide(BunSocket.layerWebSocket(url)), Layer.provide(RpcSerialization.layerNdjson)),
    );
    return yield* RpcClient.make(Api).pipe(Effect.provideContext(protocol));
  });
