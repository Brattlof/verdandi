import { randomBytes, timingSafeEqual } from "node:crypto";
import { BunHttpServer } from "@effect/platform-bun";
import { Api, type HarnessAdapter, type HarnessId, type RouteDecision, RoutingUnavailable } from "@verdandi/contracts";
import web from "@verdandi/web/index.html";
import { Context, Deferred, Effect, Layer, Result, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import { AppLayer } from "../orchestration/app.ts";
import { Engine } from "../orchestration/engine.ts";
import { loadDeciderState } from "../orchestration/projector.ts";
import { HarnessRegistry } from "../orchestration/reactor.ts";
import { loadTaskCosts } from "../orchestration/task-outcome.ts";
import { decideRoute, routingFor, rulesDecide, taskQuestions } from "../routing/routing.ts";
import { threadDiff } from "../workspace/diff.ts";
import { resolveProjectPath } from "../workspace/project.ts";

/** Where the running server listens, and the token clients must present. */
export class ServerInfo extends Context.Service<ServerInfo, { readonly port: number; readonly token: string }>()("verdandi/ServerInfo") {}

const Handlers = Api.toLayer(
  Effect.gen(function* () {
    const engine = yield* Engine;
    const sql = yield* SqlClient.SqlClient;
    const registry = yield* HarnessRegistry;
    const harnesses = Object.keys(registry) as HarnessId[];
    const routing = routingFor(registry);
    const subscriptions = new Map<string, Deferred.Deferred<void>>();
    /** Runs `feed` until `Unsubscribe` names `subscriptionId`: the server ends feeds, clients never stop them early (ADR 0008). */
    const untilUnsubscribed = <A, E>(subscriptionId: string, feed: Stream.Stream<A, E | SqlError.SqlError>) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const stop = yield* Deferred.make<void>();
          subscriptions.set(subscriptionId, stop);
          return feed.pipe(
            // interruptWhen, not haltWhen: an idle feed sits in a pull that haltWhen would wait out.
            Stream.interruptWhen(Deferred.await(stop)),
            Stream.catchTag("SqlError", Stream.die),
            Stream.ensuring(Effect.sync(() => subscriptions.delete(subscriptionId))),
          );
        }),
      );
    return {
      // The project path is a trust boundary: checked and resolved here, so the decider stays pure.
      CommandDispatch: (command) =>
        (command.type === "thread.create"
          ? Effect.map(resolveProjectPath(command.projectPath), (projectPath) => ({ ...command, projectPath }))
          : Effect.succeed(command)
        ).pipe(Effect.flatMap(engine.dispatch), Effect.catchTag("SqlError", Effect.die)),
      ThreadSubscribe: ({ threadId, subscriptionId }) => untilUnsubscribed(subscriptionId, engine.feed(threadId)),
      ProjectsSubscribe: ({ subscriptionId }) => untilUnsubscribed(subscriptionId, engine.projectsFeed),
      Unsubscribe: ({ subscriptionId }) => {
        const stop = subscriptions.get(subscriptionId);
        return stop ? Deferred.succeed(stop, undefined).pipe(Effect.asVoid) : Effect.void;
      },
      HarnessesList: () => Effect.succeed(harnesses),
      DiffGet: ({ threadId, turnId }) =>
        threadDiff(threadId, turnId).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.catchTag("SqlError", Effect.die)),
      TaskCostsList: () => loadTaskCosts.pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.catchTag("SqlError", Effect.die)),
      RoutingExplain: ({ taskId }) =>
        sql<{ payload: string }>`select payload from route_decisions where task_id = ${taskId}`.pipe(
          Effect.catchTag("SqlError", Effect.die),
          Effect.flatMap(([row]) =>
            row
              ? Effect.succeed(JSON.parse(row.payload) as RouteDecision)
              : Effect.fail(
                  new RoutingUnavailable({
                    reason: "TaskNotFound",
                    message: `Task ${taskId} has no routing decision: it doesn't exist, or it started before routing did.`,
                  }),
                ),
          ),
        ),
      RoutingSimulate: ({ threadId, text, mode }) =>
        Effect.gen(function* () {
          const { thread } = yield* loadDeciderState(threadId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catchTag("SqlError", Effect.die),
          );
          if (!thread) return yield* new RoutingUnavailable({ reason: "ThreadNotFound", message: `Thread ${threadId} does not exist.` });
          const context = yield* routing(thread.projectPath);
          const { answers } = yield* rulesDecide.decide({ state: text, questions: taskQuestions(context) });
          const decided = decideRoute(thread, context, text, mode, answers);
          if (Result.isFailure(decided)) return yield* new RoutingUnavailable(decided.failure);
          return decided.success;
        }),
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
            return HttpServerResponse.text("Missing or wrong token. Clients read it from server.json in the Verdandi home.", {
              status: 401,
            });
          }
          return yield* httpEffect;
        }),
      );
      return protocol;
    }),
  );

/** verdandid: the core, a token-protected WebSocket API and the web UI on 127.0.0.1. Port 0 picks a free port. */
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
        // RPC layer closes its client sockets, so a connected `verdandi chat` blocked shutdown. Without
        // it, the RPC layer closes the sockets first and the final stop() resolves.
        disablePreemptiveShutdown: true,
        // The web UI: Bun bundles it from source on the first request and serves it from memory.
        routes: { "/": web },
        development: false,
      }),
    ),
  );
  const info = Layer.effect(ServerInfo)(
    Effect.gen(function* () {
      const { address } = yield* HttpServer.HttpServer;
      if (address._tag === "UnixPathAddress") return yield* Effect.die("verdandid must listen on TCP");
      return { port: address.port, token };
    }),
  );
  return info.pipe(Layer.provideMerge(http), Layer.provideMerge(AppLayer(home, harnesses)));
};
