import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientCommand, CommandId, Resolution, ThreadFeed, ThreadId, ThreadView, TurnId } from "@verdandi/contracts";
import { Context, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { resolveHome, type ServerFile, serverFile } from "../config/home.ts";
import { connect } from "../rpc/client.ts";
import { approvalPrompt, type PendingRequest, parseAnswer, questionPrompt } from "./requests.ts";
import { describeRouteChange, routeFromFlags } from "./route-flags.ts";

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
  const route = routeFromFlags(argv); // also rejects bad flags before connecting

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
  /** The turn a typed line steers; undefined while the thread is idle. */
  let running: TurnId | undefined;
  const snapshot = Promise.withResolvers<ThreadView>();
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
            running = f.thread.turns.find((t) => t.status === "running")?.turnId;
            requests.push(...f.thread.pendingRequests);
            snapshot.resolve(f.thread);
          }
          if (f.kind === "delta") process.stdout.write(f.text);
          if (f.kind !== "event") return;
          const e = f.stored.event;
          if (e.type === "turn.started") running = e.turnId;
          if (e.type === "approval.requested" || e.type === "user-input.requested") addRequest(e);
          if (e.type === "approval.resolved") removeRequest(e.requestId);
          if (e.type === "turn.usage.recorded") usage.push(e);
          if (e.type === "turn.completed") {
            process.stdout.write(summary(e.status, e.error, usage));
            usage = [];
            if (running === e.turnId) running = undefined;
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

  /** Steers the running turn. False when that turn finished first, so the line goes out as the next turn. */
  const steer = (turnId: TurnId, text: string) =>
    runtime.runPromise(
      client.CommandDispatch({ type: "turn.steer", commandId: uuid<CommandId>(), threadId, turnId, text }).pipe(
        Effect.as(true),
        Effect.catchTag("CommandRejected", (e) =>
          e.reason === "TurnNotRunning"
            ? Effect.succeed(false)
            : Effect.sync(() => process.stdout.write(`${e.message}\n`)).pipe(Effect.as(true)),
        ),
      ),
    );

  // Ctrl+C interrupts the running turn. A second Ctrl+C before it ends, or one at the prompt, quits.
  let interrupting: TurnId | undefined;
  process.on("SIGINT", () => {
    if (!running || interrupting === running) process.exit(130);
    interrupting = running;
    process.stdout.write("\n[interrupting: Ctrl+C again to quit]\n");
    void dispatch({ type: "turn.interrupt", commandId: uuid<CommandId>(), threadId, turnId: running });
  });

  const noSnapshot = new Error("The thread feed ended before its snapshot arrived. Restart verdandid and try again.");
  feed.then(() => snapshot.reject(noSnapshot), snapshot.reject);
  const thread = await snapshot.promise;
  // Flags that differ from the thread's route change it, from the next turn on.
  const wanted = routeFromFlags(argv, thread.route);
  const change = describeRouteChange(thread.route, wanted);
  const changed = change !== "" && (await dispatch({ type: "thread.route.set", commandId: uuid<CommandId>(), threadId, route: wanted }));
  const { harness, model, effort } = changed ? wanted : thread.route;
  process.stdout.write(
    `Thread ${threadId} in ${thread.projectPath} (${thread.turns.length} earlier turns) on ${harness} ${model} ${effort}. Ctrl+C stops a turn; /exit quits.\n`,
  );
  if (changed) process.stdout.write(`Route changed: ${change}\n`);
  if (running) process.stdout.write("A turn is running; lines you type steer it.\n");
  else prompt();
  showRequest();

  for await (const line of console) {
    const text = line.trim();
    const request = requests[0];
    if (request) await answer(request, text);
    else if (text === "/exit") break;
    else if (!text) {
      if (!running) prompt();
    } else if (running && (await steer(running, text))) process.stdout.write("[steer sent: the agent reads it at its next step]\n");
    else {
      const turnId = uuid<TurnId>();
      running = turnId;
      if (!(await dispatch({ type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId, text }))) {
        running = undefined;
        prompt();
      }
    }
  }
  await runtime.runPromise(client.ThreadUnsubscribe({ subscriptionId }));
  await feed;
  await runtime.dispose();
};
