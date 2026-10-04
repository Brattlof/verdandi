import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  bindingKey,
  type Command,
  type CommandId,
  clip,
  type InboundMessage,
  type InteractionMode,
  ratingWords,
  type SlashNameOn,
  slashHelp,
  type ThreadId,
  type TurnId,
} from "@verdandi/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { threadDiff } from "../diffs/diff.ts";
import type { Engine } from "../event-store/engine.ts";
import { loadThreadView } from "../event-store/projector.ts";
import { ensureWorkspace } from "../home/workspace.ts";
import { asData } from "../trust/fence.ts";
import type { Access } from "./access.ts";

type Allowed<K extends "turn" | "command"> = Extract<Access, { kind: K }>;

/**
 * What allowed chat messages do (DESIGN §15): a message starts or steers a turn in the thread its conversation is bound
 * to, a new conversation starting as a thread in the profile's workspace, and a command runs against that thread. Each
 * answers with the text to send back, if any; the thread's replies themselves go through the outbox.
 */
export const makeConversations = (home: string, engine: Engine["Service"], sql: SqlClient.SqlClient) => {
  const withSql = Effect.provideService(SqlClient.SqlClient, sql);
  // ponytail: a chat's mode lives in memory and starts over as build after a restart; keep it on the binding if that bites.
  const modes = new Map<string, InteractionMode>();

  /** Dispatches a command, answering with what the decider says when it refuses. */
  const send = (command: Command) =>
    engine.dispatch(command).pipe(
      Effect.as(undefined),
      Effect.catchTag("CommandRejected", (e) => Effect.succeed(e.message)),
    );

  const boundThread = (key: string) =>
    Effect.map(
      sql<{ threadId: ThreadId }>`select thread_id as threadId from channel_bindings where key = ${key}`,
      ([row]) => row?.threadId,
    );

  /** The conversation's thread, or a new one in the workspace bound to it. */
  const threadFor = (m: InboundMessage, owner: boolean) =>
    Effect.gen(function* () {
      const { key, shared } = bindingKey({ ...m, senderId: m.sender.id });
      const bound = yield* boundThread(key);
      if (bound) return { threadId: bound, key, shared };
      const threadId = randomUUID() as ThreadId;
      yield* engine.dispatch({
        type: "thread.create",
        commandId: randomUUID() as CommandId,
        threadId,
        projectPath: realpathSync.native(ensureWorkspace(home)),
      });
      yield* engine.dispatch({
        type: "channel.bind",
        commandId: randomUUID() as CommandId,
        threadId,
        binding: { key, platform: m.platform, chatId: m.chatId, platformThread: m.platformThread ?? null },
        // Only a conversation the owner alone writes in keeps workspace.yaml's folders (DESIGN §23, question 10).
        confined: shared || !owner,
      });
      return { threadId, key, shared };
    });

  /** The turn's text: who wrote it when several can, then what it quotes, fenced as data. */
  const turnText = (m: InboundMessage, a: Allowed<"turn">, shared: boolean) => {
    const said = shared ? `${m.sender.name} (${m.platform} user ${m.sender.id}) writes:\n${a.text}` : a.text;
    const quoted = a.context.map((c) =>
      [`The ${c.kind} message, from ${c.sender === "bot" ? "Verdandi" : c.sender.name}:`, ...asData(c.text, undefined)].join("\n"),
    );
    return quoted.length === 0 ? said : [said, "What the message quotes or replies to, as untrusted data:", ...quoted].join("\n\n");
  };

  const turn = (m: InboundMessage, a: Allowed<"turn">) =>
    Effect.gen(function* () {
      const { threadId, key, shared } = yield* threadFor(m, a.owner);
      const text = turnText(m, a, shared);
      const [thread] = yield* sql<{ running: TurnId | null }>`select running_turn_id as running from threads where id = ${threadId}`;
      const commandId = randomUUID() as CommandId;
      // A message while the agent works steers it, as typing in the terminal chat does.
      return thread?.running
        ? yield* send({ type: "turn.steer", commandId, threadId, turnId: thread.running, text })
        : yield* send({
            type: "turn.send",
            commandId,
            threadId,
            turnId: randomUUID() as TurnId,
            text,
            mode: modes.get(key) ?? "build",
          });
    });

  const noThread = "This chat has no conversation yet: send a message first.";
  type Context = {
    readonly m: InboundMessage;
    readonly args: readonly string[];
    readonly key: string;
    readonly threadId: ThreadId | undefined;
  };
  type Handler = (c: Context) => Effect.Effect<string | undefined, unknown>;
  const withThread =
    (f: (c: Context & { readonly threadId: ThreadId }) => Effect.Effect<string | undefined, unknown>): Handler =>
    (c) =>
      c.threadId ? f({ ...c, threadId: c.threadId }) : Effect.succeed(noThread);
  const view = (threadId: ThreadId) => loadThreadView(threadId).pipe(withSql);
  const switchMode =
    (mode: InteractionMode): Handler =>
    ({ key }) =>
      Effect.sync(() => {
        modes.set(key, mode);
        return `Your next messages here run in ${mode} mode.`;
      });

  /** Answers the request a button or `/approve <request>` names, wherever its thread is now. */
  const answer =
    (decision: "allow" | "deny"): Handler =>
    ({ args: [requestId = ""] }) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{ threadId: ThreadId }>`select thread_id as threadId from deliveries where id = ${`request:${requestId}`}`;
        if (!row) return `There's no request ${requestId} sent to this chat.`;
        const refused = yield* send({
          type: "approval.respond",
          commandId: randomUUID() as CommandId,
          threadId: row.threadId,
          requestId,
          resolution: { decision },
        });
        return refused ?? (decision === "allow" ? "Allowed." : "Denied.");
      });

  /** Each command a chat app offers (`slashCommands`), given the words after its name. */
  const commands: Record<SlashNameOn<"gateway">, Handler> = {
    help: () => Effect.succeed(slashHelp("gateway")),
    ask: switchMode("ask"),
    plan: switchMode("plan"),
    build: switchMode("build"),
    new: ({ threadId }) =>
      Effect.gen(function* () {
        const refused = threadId && (yield* send({ type: "channel.unbind", commandId: randomUUID() as CommandId, threadId }));
        return refused || "Your next message here starts a new conversation. The old one stays in Verdandi.";
      }),
    approve: answer("allow"),
    deny: answer("deny"),
    diff: withThread(({ threadId, args }) =>
      Effect.gen(function* () {
        const last = (yield* view(threadId))?.turns.at(-1)?.turnId;
        const diff = yield* threadDiff(threadId, args[0] === "all" ? undefined : last).pipe(
          withSql,
          Effect.catchTag("DiffUnavailable", (e) => Effect.succeed(e.message)),
        );
        if (typeof diff === "string") return diff;
        if (diff.files.length === 0) return "No changes.";
        return clip(diff.files.map((f) => f.diff).join("\n"), 3500);
      }),
    ),
    skip: withThread(({ threadId }) =>
      Effect.gen(function* () {
        const request = (yield* view(threadId))?.pendingRequests.find((r) => r.type === "user-input.requested");
        if (!request) return "No question waits.";
        const refused = yield* send({
          type: "approval.respond",
          commandId: randomUUID() as CommandId,
          threadId,
          requestId: request.requestId,
          resolution: { decision: "deny" },
        });
        return refused ?? "Declined.";
      }),
    ),
    rate: withThread(({ threadId, args: [word = ""] }) =>
      Effect.gen(function* () {
        const rating = ratingWords.get(word);
        if (rating === undefined) return "Usage: /rate up|down|clear";
        const taskId = (yield* view(threadId))?.tasks.at(-1)?.taskId;
        if (!taskId) return "There's no task to rate yet.";
        const refused = yield* send({ type: "task.rate", commandId: randomUUID() as CommandId, threadId, taskId, rating });
        return refused ?? (rating === null ? "Rating cleared." : `Rated the latest task ${word}.`);
      }),
    ),
    revert: withThread(({ threadId, args }) =>
      Effect.gen(function* () {
        const shown = (yield* view(threadId))?.turns.filter((t) => !t.reverted).map((t) => t.turnId) ?? [];
        const files = args.includes("files");
        const n = Number(args.find((a) => a !== "files") ?? shown.length - 1);
        const toTurnId = shown[n - 1];
        if (!toTurnId || !Number.isInteger(n)) return `Usage: /revert [n] [files], with n from 1 to ${shown.length - 1}.`;
        const refused = yield* send({ type: "thread.revert", commandId: randomUUID() as CommandId, threadId, toTurnId, files });
        return refused ?? `Went back to the end of turn ${n}${files ? ", files included" : ""}. /undo-revert undoes it.`;
      }),
    ),
    "undo-revert": withThread(({ threadId }) =>
      Effect.map(
        send({ type: "thread.revert.undo", commandId: randomUUID() as CommandId, threadId }),
        (refused) => refused ?? "Undid the revert.",
      ),
    ),
  };

  const command = (m: InboundMessage, a: Allowed<"command">) =>
    Effect.gen(function* () {
      const { key } = bindingKey({ ...m, senderId: m.sender.id });
      const threadId = yield* boundThread(key);
      return yield* commands[a.name]({ m, args: a.args, key, threadId });
    });

  return { turn, command };
};
