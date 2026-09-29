import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CommandId, Route, type ThreadFeed, type ThreadId, type TurnId } from "@goldiloop/contracts";
import { Context, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { flag, resolveHome, type ServerFile, serverFile } from "../config/home.ts";
import { connect } from "../rpc/client.ts";

class Client extends Context.Service<Client, Effect.Success<ReturnType<typeof connect>>>()("goldiloop/cli/Client") {}

const uuid = <T>() => crypto.randomUUID() as T;

/** The CLI remembers one thread per folder, in the Goldiloop home. */
const threadsFile = (home: string) => join(home, "cli-threads.json");
const readThreads = (home: string): Record<string, string> =>
  existsSync(threadsFile(home)) ? JSON.parse(readFileSync(threadsFile(home), "utf8")) : {};

type Usage = { model: string; accessMode: string; inputTokens: number; outputTokens: number; costUsd: number };

const summary = (status: string, error: string | undefined, usage: Usage[]) => {
  const parts = usage.map((u) => `${u.model} ${u.inputTokens}→${u.outputTokens} tok $${u.costUsd.toFixed(4)} ${u.accessMode}`);
  return `\n[${status}${error ? `: ${error}` : ""}${parts.length ? ` · ${parts.join(" · ")}` : ""}]\n`;
};

/** `goldiloop chat`: a simple terminal chat with the thread for the current folder. */
export const chat = async (argv: readonly string[]) => {
  const home = resolveHome(argv);
  if (!existsSync(serverFile(home))) throw new Error(`goldiloopd is not running for ${home}. Start it with: goldiloop start`);
  const server = JSON.parse(readFileSync(serverFile(home), "utf8")) as ServerFile;
  const route = Schema.decodeUnknownSync(Route)({
    harness: flag(argv, "--harness") ?? "claude-code",
    model: flag(argv, "--model") ?? "sonnet",
    effort: flag(argv, "--effort") ?? "medium",
  });

  const runtime = ManagedRuntime.make(Layer.effect(Client)(connect(server)));
  const client = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* Client;
    }),
  );
  const cwd = process.cwd();
  const threads = readThreads(home);
  let threadId = threads[cwd] as ThreadId | undefined;
  if (!threadId) {
    threadId = uuid<ThreadId>();
    await runtime.runPromise(
      client.CommandDispatch({ type: "thread.create", commandId: uuid<CommandId>(), threadId, projectPath: cwd, route }),
    );
    writeFileSync(threadsFile(home), JSON.stringify({ ...threads, [cwd]: threadId }, null, 2));
  }

  let finishTurn: (() => void) | undefined;
  let usage: Usage[] = [];
  const subscriptionId = crypto.randomUUID();
  const feed = runtime.runPromise(
    client.ThreadSubscribe({ threadId, subscriptionId }).pipe(
      Stream.runForEach((f: ThreadFeed) =>
        Effect.sync(() => {
          if (f.kind === "snapshot") {
            const { threadId, projectPath, turns } = f.thread;
            process.stdout.write(`Thread ${threadId} in ${projectPath} (${turns.length} earlier turns). /exit to quit.\n> `);
          }
          if (f.kind === "delta") process.stdout.write(f.text);
          if (f.kind !== "event") return;
          const e = f.stored.event;
          if (e.type === "turn.usage.recorded") usage.push(e);
          if (e.type === "turn.completed") {
            process.stdout.write(summary(e.status, e.error, usage));
            usage = [];
            finishTurn?.();
          }
        }),
      ),
    ),
  );

  for await (const line of console) {
    const text = line.trim();
    if (text === "/exit") break;
    if (text) {
      const done = new Promise<void>((resolve) => (finishTurn = resolve));
      await runtime.runPromise(
        client.CommandDispatch({ type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId: uuid<TurnId>(), text }),
      );
      await done;
    }
    process.stdout.write("> ");
  }
  await runtime.runPromise(client.ThreadUnsubscribe({ subscriptionId }));
  await feed;
  await runtime.dispose();
};
