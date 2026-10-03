import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { BunHttpServer } from "@effect/platform-bun";
import {
  Api,
  atPin,
  type Command,
  CommandRejected,
  type HarnessAdapter,
  type HarnessId,
  type PairMessage,
  type RouteDecision,
  RoutingUnavailable,
  SpendCapsUnavailable,
  TerminalUnavailable,
} from "@verdandi/contracts";
import { Context, Deferred, Effect, Layer, Option, Result, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import { AttachmentSweepLive, attachmentPath, attachmentsDir, storeAttachments } from "../attachments/attachments.ts";
import { Devices, DevicesLive } from "../devices/devices.ts";
import { threadDiff } from "../diffs/diff.ts";
import { AppLayer } from "../event-store/app.ts";
import { reachedCap } from "../event-store/decider.ts";
import { Engine } from "../event-store/engine.ts";
import { loadDeciderState, loadMemory } from "../event-store/projector.ts";
import { HarnessRegistry, ProfileSkills } from "../event-store/reactor.ts";
import { Gc, GcLive, GcScheduleLive } from "../gc/gc.ts";
import { workspaceDir } from "../home/workspace.ts";
import { pickFolder } from "../projects/folder-picker.ts";
import { resolveProjectPath } from "../projects/project.ts";
import { catalogFor, decideRoute, routingFor, rulesDecide, taskQuestions } from "../routing/routing.ts";
import { loadRoutingMemory } from "../routing/routing-memory.ts";
import { searchSessions } from "../search/search.ts";
import { loadSkillsView, SkillCurationScheduleLive } from "../skills/skill-curation.ts";
import { loadSkillHistory } from "../skills/skill-history.ts";
import { loadSpendState } from "../spend/spend.ts";
import { loadSpendCaps } from "../spend/spend-caps.ts";
import { loadUsageReport } from "../spend/usage.ts";
import { loadTaskCosts } from "../tasks/task-outcome.ts";
import { Terminals, TerminalsLive } from "../terminals/terminals.ts";
import { listTrusted } from "../trust/trust.ts";
import { loadThreadFolder } from "../worktrees/worktree.ts";

/** Where the running server listens, and the token clients must present. */
export class ServerInfo extends Context.Service<ServerInfo, { readonly port: number; readonly token: string }>()("verdandi/ServerInfo") {}

const Handlers = (home: string) =>
  Api.toLayer(
    Effect.gen(function* () {
      const engine = yield* Engine;
      const sql = yield* SqlClient.SqlClient;
      const registry = yield* HarnessRegistry;
      const terminals = yield* Terminals;
      const gc = yield* Gc;
      const skillFolders = yield* ProfileSkills;
      const devices = yield* Devices;
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
        // Trust boundaries, checked here so the decider stays pure: the project path is resolved, and
        // attachments are checked and stored, so the command and its events carry references, never bytes.
        CommandDispatch: (command) =>
          (command.type === "thread.create"
            ? Effect.map(resolveProjectPath(command.projectPath), (projectPath): Command => ({ ...command, projectPath }))
            : command.type === "turn.send"
              ? Effect.map(
                  // Stored before the engine accepts the turn: a rejected turn's bytes stay until the daily sweep (AttachmentSweepLive).
                  storeAttachments(attachmentsDir(home), command.attachments ?? []),
                  (refs): Command => {
                    const { attachments: _, ...rest } = command;
                    return refs.length > 0 ? { ...rest, attachments: refs } : rest;
                  },
                )
              : Effect.succeed(command)
          ).pipe(Effect.flatMap(engine.dispatch), Effect.catchTag("SqlError", Effect.die)),
        ThreadSubscribe: ({ threadId, subscriptionId }) => untilUnsubscribed(subscriptionId, engine.feed(threadId)),
        ProjectsSubscribe: ({ subscriptionId, archived }) =>
          untilUnsubscribed(subscriptionId, engine.projectsFeed(archived ?? false, workspaceDir(home))),
        Unsubscribe: ({ subscriptionId }) => {
          const stop = subscriptions.get(subscriptionId);
          return stop ? Deferred.succeed(stop, undefined).pipe(Effect.asVoid) : Effect.void;
        },
        HarnessesList: () => Effect.succeed(harnesses),
        ModelsList: () =>
          Effect.succeed(
            catalogFor(registry)
              .filter((e) => harnesses.includes(e.harness))
              .map(({ harness, provider, model, access, efforts }) => ({
                harness,
                provider,
                model,
                access,
                efforts,
              })),
          ),
        FolderPick: () => pickFolder,
        DiffGet: ({ threadId, turnId }) =>
          threadDiff(threadId, turnId).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.catchTag("SqlError", Effect.die)),
        SpendCapsGet: ({ threadId }) =>
          Effect.gen(function* () {
            const { thread } = yield* loadDeciderState(threadId);
            if (!thread)
              return yield* new SpendCapsUnavailable({ reason: "ThreadNotFound", message: `Thread ${threadId} does not exist.` });
            const spend = yield* loadSpendState(loadSpendCaps(home), thread.projectPath, new Date());
            if (Result.isFailure(spend)) return yield* new SpendCapsUnavailable({ reason: "InvalidSpendCaps", message: spend.failure });
            return spend.success.caps;
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.catchTag("SqlError", Effect.die)),
        UsageQuery: (filter) =>
          loadUsageReport(filter, new Date()).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catchTag("SqlError", Effect.die),
          ),
        MemoryList: ({ threadId }) =>
          loadMemory(threadId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catchTag("SqlError", Effect.die),
            Effect.flatMap((view) =>
              view
                ? Effect.succeed(view)
                : Effect.fail(new CommandRejected({ reason: "ThreadNotFound", message: `Thread ${threadId} does not exist.` })),
            ),
          ),
        // Read from disk on each call: the user may add or edit skills by hand.
        SkillsList: () =>
          loadSkillsView.pipe(
            Effect.provideService(ProfileSkills, skillFolders),
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catchTag("SqlError", Effect.die),
          ),
        SkillHistoryGet: ({ skill }) =>
          loadSkillHistory(skill).pipe(
            Effect.provideService(ProfileSkills, skillFolders),
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catchTag("SqlError", Effect.die),
          ),
        TrustedCommandsList: ({ threadId }) =>
          listTrusted(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.catchTag("SqlError", Effect.die)),
        SessionSearch: (query) =>
          searchSessions(query).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.catchTag("SqlError", Effect.die)),
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
        RoutingSimulate: ({ threadId, text, mode, images }) =>
          Effect.gen(function* () {
            const { thread } = yield* loadDeciderState(threadId).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.catchTag("SqlError", Effect.die),
            );
            if (!thread) return yield* new RoutingUnavailable({ reason: "ThreadNotFound", message: `Thread ${threadId} does not exist.` });
            const memory = yield* loadRoutingMemory(threadId).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.catchTag("SqlError", Effect.die),
            );
            // The preview routes around a reached spend cap the way the turn would.
            const spend = yield* loadSpendState(loadSpendCaps(home), thread.projectPath, new Date()).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.catchTag("SqlError", Effect.die),
            );
            const cap = reachedCap(spend);
            const context = { ...(yield* routing(thread.projectPath)), memory, ...(cap && { capped: cap }) };
            const at = atPin(text);
            const task = at ? at.text : text;
            const { answers } = yield* rulesDecide.decide({ state: task, questions: taskQuestions(context) });
            const decided = decideRoute(thread, context, task, mode, answers, images, at?.name);
            if (Result.isFailure(decided)) return yield* new RoutingUnavailable(decided.failure);
            return decided.success;
          }),
        Gc: ({ dryRun }) => gc.run({ dryRun, now: Date.now() }),
        TerminalOpen: ({ threadId, cols, rows }) =>
          loadThreadFolder(threadId).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catchTag("SqlError", Effect.die),
            Effect.flatMap((cwd) =>
              cwd === undefined
                ? Effect.fail(new TerminalUnavailable({ reason: "ThreadNotFound", message: `Thread ${threadId} does not exist.` }))
                : terminals.open(threadId, cwd, cols, rows),
            ),
          ),
        TerminalList: ({ threadId }) => Effect.sync(() => terminals.list(threadId)),
        TerminalWrite: ({ terminalId, data }) => terminals.write(terminalId, data),
        TerminalResize: ({ terminalId, cols, rows }) => terminals.resize(terminalId, cols, rows),
        TerminalClose: ({ terminalId }) => terminals.close(terminalId),
        DevicesSubscribe: ({ subscriptionId }) => untilUnsubscribed(subscriptionId, devices.feed),
        DevicesList: () => devices.view,
        DeviceApprove: ({ requestId }) => devices.approve(requestId),
        DeviceDeny: ({ requestId }) => devices.deny(requestId),
        TerminalSubscribe: ({ terminalId, subscriptionId }) => untilUnsubscribed(subscriptionId, terminals.feed(terminalId)),
      };
    }),
  );

const sameToken = (given: string | null, token: string) =>
  given !== null && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));

const imageTypes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/**
 * Who a request comes from (ADR 0028): the profile, whose token the CLI and `verdandi web`'s relay hold, sent as
 * `?token=` or `Authorization: Bearer`; a paired device that isn't revoked, sent as `?device=` or
 * `Authorization: Device`; or nobody. Each kind is checked only as itself, so a relay that passes device tokens
 * through can't pass the profile's.
 */
const holder = (request: HttpServerRequest.HttpServerRequest, token: string) =>
  Effect.gen(function* () {
    const query = new URL(request.url, "http://localhost").searchParams;
    const [scheme, value = null] = request.headers.authorization?.split(" ") ?? [];
    const profile = query.get("token") ?? (scheme === "Bearer" ? value : null);
    if (sameToken(profile, token)) return { kind: "profile" } as const;
    const device = query.get("device") ?? (scheme === "Device" ? value : null);
    const deviceId = device ? yield* (yield* Devices).authenticate(device) : undefined;
    return deviceId ? ({ kind: "device", deviceId } as const) : undefined;
  });

const wrongToken = () =>
  HttpServerResponse.text(
    "Missing, wrong or revoked token. Clients on this machine read it from server.json in the Verdandi home; other devices pair first.",
    { status: 401 },
  );

/**
 * An attachment's stored bytes, for the web UI's thumbnails. The token comes in an `Authorization: Bearer`
 * header, never the URL. Only the four image types are served inline; anything else downloads, and nothing
 * served here can run script.
 */
const serveAttachment = (home: string, token: string) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!(yield* holder(request, token))) return wrongToken();
    const id = new URL(request.url, "http://localhost").pathname.split("/").at(-1) ?? "";
    const path = attachmentPath(attachmentsDir(home), id);
    if (!path || !existsSync(path)) return HttpServerResponse.text("No such attachment.", { status: 404 });
    const image = imageTypes[id.split(".")[1] ?? ""];
    return HttpServerResponse.uint8Array(readFileSync(path), {
      contentType: image ?? "application/octet-stream",
      headers: {
        "cache-control": "private, max-age=31536000, immutable",
        "content-security-policy": "default-src 'none'; sandbox",
        "x-content-type-options": "nosniff",
        ...(image ? {} : { "content-disposition": "attachment" }),
      },
    });
  });

/** verdandid serves no page (ADR 0026): a browser sends its `Origin`, and the CLI and `verdandi web`'s relay send none. */
const refusePage = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.origin === undefined
    ? undefined
    : HttpServerResponse.text(
        `Refused a connection from a page at ${request.headers.origin}: verdandid serves no web page, and browsers reach it only through the web UI. Open it with: verdandi web`,
        { status: 403 },
      );

/**
 * A device asking to pair (ADR 0028), over a WebSocket that sends `PairMessage`s: the request with its code, then the
 * token once the owner approves, or why not. The request is withdrawn when the socket closes first. The address is the
 * one `x-verdandi-client` names (the web server relaying it sets it), else the socket's: a hint for the owner, never a
 * check, since the code is the check.
 */
const pair = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const refused = refusePage(request);
  if (refused) return refused;
  const devices = yield* Devices;
  const address = request.headers["x-verdandi-client"] ?? Option.getOrElse(request.remoteAddress, () => "unknown");
  const socket = yield* Effect.orDie(request.upgrade);
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writer = yield* socket.writer;
      // Each answer but `pending` is the last: the socket closes after it.
      const send = (message: PairMessage) =>
        writer
          .write(JSON.stringify(message))
          .pipe(Effect.andThen(message.kind === "pending" ? Effect.void : writer.write(new Socket.CloseEvent(1000))));
      const raised = yield* devices.request({ address, userAgent: request.headers["user-agent"] ?? "" });
      if (typeof raised === "string") return yield* send({ kind: "refused", message: raised });
      yield* Effect.addFinalizer(() => devices.withdraw(raised.request.requestId));
      yield* send({ kind: "pending", requestId: raised.request.requestId, code: raised.request.code });
      // Reading ends when the device closes the socket, which withdraws the request.
      const reader = yield* socket.reader;
      const outcome = yield* Effect.raceFirst(
        Deferred.await(raised.outcome),
        reader.pull.pipe(Effect.forever, Effect.ignore, Effect.as(undefined)),
      );
      if (outcome) yield* send(outcome);
    }).pipe(Effect.ignore),
  );
  return HttpServerResponse.empty();
});

/**
 * The WebSocket RPC protocol at /rpc, attachments at /attachments/<id>, pairing at /pair, and /auth, which says whose a
 * token is. /rpc refuses every browser page, then an upgrade without the profile's token or a paired device's. A device's
 * connection closes as soon as it's revoked.
 */
const ProtocolWithToken = (home: string, token: string) =>
  Layer.effect(RpcServer.Protocol)(
    Effect.gen(function* () {
      const { httpEffect, protocol } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
      const router = yield* HttpRouter.HttpRouter;
      const devices = yield* Devices;
      const withDevices = Effect.provideService(Devices, devices);
      // Released before the HTTP server stops, which waits for open sockets: waiting pairings end first.
      yield* Effect.addFinalizer(() => devices.refuseAll);
      yield* router.add("GET", "/attachments/:id", withDevices(serveAttachment(home, token)));
      yield* router.add("GET", "/pair", withDevices(pair));
      yield* router.add(
        "GET",
        "/auth",
        Effect.gen(function* () {
          const who = yield* holder(yield* HttpServerRequest.HttpServerRequest, token);
          return who ? HttpServerResponse.jsonUnsafe(who) : wrongToken();
        }).pipe(withDevices),
      );
      yield* router.add(
        "GET",
        "/rpc",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const refused = refusePage(request);
          if (refused) return refused;
          const who = yield* holder(request, token);
          if (!who) return wrongToken();
          if (who.kind === "profile") return yield* httpEffect;
          return yield* Effect.scoped(
            Effect.flatMap(devices.revoked(who.deviceId), (revoked) =>
              Effect.raceFirst(httpEffect, Effect.as(Deferred.await(revoked), HttpServerResponse.empty())),
            ),
          );
        }).pipe(withDevices),
      );
      return protocol;
    }),
  );

/** verdandid: the core and its token-protected WebSocket API on 127.0.0.1, serving no web page (ADR 0026). Port 0 picks a free port. */
export const ServerLayer = (
  home: string,
  harnesses: Partial<Record<HarnessId, HarnessAdapter>>,
  options: { readonly port?: number } = {},
) => {
  const token = randomBytes(32).toString("hex");
  const rpc = RpcServer.layer(Api).pipe(
    Layer.provide(Handlers(home)),
    Layer.provide(ProtocolWithToken(home, token)),
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
        // A turn's attachments arrive base64-encoded in one message: at most 10 MB of bytes (contracts' attachmentLimits).
        websocket: { maxPayloadLength: 20 * 1024 * 1024 },
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
  return Layer.mergeAll(info, AttachmentSweepLive(home), GcScheduleLive, SkillCurationScheduleLive).pipe(
    Layer.provideMerge(http),
    Layer.provideMerge(TerminalsLive),
    Layer.provideMerge(GcLive(home)),
    Layer.provideMerge(DevicesLive),
    Layer.provideMerge(AppLayer(home, harnesses)),
  );
};
