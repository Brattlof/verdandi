import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ClientCommand,
  type CommandId,
  type Resolution,
  Route,
  type ThreadFeed,
  type ThreadId,
  type TurnId,
} from "@verdandi/contracts";
import { Context, Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { flag, resolveHome, type ServerFile, serverFile } from "../config/home.ts";
import { connect } from "../rpc/client.ts";
import { approvalPrompt, type PendingRequest, parseAnswer, questionPrompt } from "./requests.ts";

class Client extends Context.Service<Client, Effect.Success<ReturnType<typeof connect>>>()("verdandi/cli/Client") {}

const uuid = <T>() => crypto.randomUUID() as T;

/** The CLI remembers one thread per folder, in the Verdandi home. */
const threadsFile = (home: string) => join(home, "cli-threads.json");
const readThreads = (home: string): Record<string, string> =>
  existsSync(threadsFile(home)) ? JSON.parse(readFileSync(threadsFile(home), "utf8")) : {};

type Usage = { model: string; accessMode: string; inputTokens: number; outputTokens: number; costUsd: number };

const summary = (status: string, error: string | undefined, usage: Usage[]) => {
  const parts = usage.map((u) => `${u.model} ${u.inputTokens}→${u.outputTokens} tok $${u.costUsd.toFixed(4)} ${u.accessMode}`);
  return `\n[${status}${error ? `: ${error}` : ""}${parts.length ? ` · ${parts.join(" · ")}` : ""}]\n`;
};

/** `verdandi chat`: a simple terminal chat with the thread for the current folder. */
export const chat = async (argv: readonly string[]) => {
  const home = resolveHome(argv);
  if (!existsSync(serverFile(home))) throw new Error(`verdandid is not running for ${home}. Start it with: verdandi start`);
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

  const dispatch = (command: ClientCommand) =>
    runtime.runPromise(
      client.CommandDispatch(command).pipe(
        Effect.as(true),
        Effect.catchTag("CommandRejected", (e) => Effect.sync(() => process.stdout.write(`${e.message}\n`)).pipe(Effect.as(false))),
      ),
    );

  // Requests are answered one at a time, oldest first. `answered` collects the current user-input request's answers.
  const requests: PendingRequest[] = [];
  let answered: string[] = [];
  let busy = false;
  let usage: Usage[] = [];
  const prompt = () => process.stdout.write("> ");
  const showRequest = () => {
    const r = requests[0];
    if (!r) return;
    if (r.type === "approval.requested") process.stdout.write(approvalPrompt(r));
    else {
      const next = r.questions[answered.length];
      if (next) process.stdout.write(questionPrompt(next));
    }
  };
  const addRequest = (r: PendingRequest) => {
    requests.push(r);
    if (requests.length === 1) showRequest();
  };
  const removeRequest = (requestId: string) => {
    const i = requests.findIndex((r) => r.requestId === requestId);
    if (i < 0) return;
    requests.splice(i, 1);
    if (i === 0) {
      answered = [];
      showRequest();
    }
  };

  const subscriptionId = crypto.randomUUID();
  // The consumer only prints and updates state; every RPC call happens in the input loop below (ADR 0008).
  const feed = runtime.runPromise(
    client.ThreadSubscribe({ threadId, subscriptionId }).pipe(
      Stream.runForEach((f: ThreadFeed) =>
        Effect.sync(() => {
          if (f.kind === "snapshot") {
            const { threadId, projectPath, turns } = f.thread;
            process.stdout.write(`Thread ${threadId} in ${projectPath} (${turns.length} earlier turns). /exit to quit.\n`);
            busy = f.thread.busy;
            if (!busy) prompt();
            for (const r of f.thread.pendingRequests) addRequest(r);
          }
          if (f.kind === "delta") process.stdout.write(f.text);
          if (f.kind !== "event") return;
          const e = f.stored.event;
          if (e.type === "turn.started") busy = true;
          if (e.type === "approval.requested" || e.type === "user-input.requested") addRequest(e);
          if (e.type === "approval.resolved") removeRequest(e.requestId);
          if (e.type === "turn.usage.recorded") usage.push(e);
          if (e.type === "turn.completed") {
            process.stdout.write(summary(e.status, e.error, usage));
            usage = [];
            busy = false;
            prompt();
          }
        }),
      ),
    ),
  );

  const resolve = async (request: PendingRequest, resolution: Resolution) => {
    await dispatch({ type: "approval.respond", commandId: uuid<CommandId>(), threadId, requestId: request.requestId, resolution });
    removeRequest(request.requestId);
  };

  /** A line typed while a request is waiting answers it. */
  const answer = async (request: PendingRequest, line: string) => {
    if (request.type === "approval.requested") {
      const yes = /^y(es)?$/i.test(line);
      if (yes || /^no?$/i.test(line)) return resolve(request, { decision: yes ? "allow" : "deny" });
      return process.stdout.write("Answer y or n: ");
    }
    if (line === "/skip") return resolve(request, { decision: "deny" });
    const question = request.questions[answered.length];
    const picked = question && parseAnswer(question, line);
    if (!question || picked === undefined) return showRequest();
    answered.push(picked);
    if (answered.length < request.questions.length) return showRequest();
    const answers = Object.fromEntries(request.questions.map((q, i) => [q.question, answered[i] ?? ""]));
    return resolve(request, { decision: "answer", answers });
  };

  for await (const line of console) {
    const text = line.trim();
    const request = requests[0];
    if (request) await answer(request, text);
    else if (text === "/exit") break;
    else if (busy) process.stdout.write("A turn is running. Wait for it to finish.\n");
    else if (!text) prompt();
    else {
      busy = true;
      const sent = await dispatch({ type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId: uuid<TurnId>(), text });
      if (!sent) {
        busy = false;
        prompt();
      }
    }
  }
  await runtime.runPromise(client.ThreadUnsubscribe({ subscriptionId }));
  await feed;
  await runtime.dispose();
};
