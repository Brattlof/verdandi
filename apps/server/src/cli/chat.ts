import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ClientCommand,
  CommandId,
  DiffView,
  InteractionMode,
  ProjectsFeed,
  Resolution,
  ThreadFeed,
  ThreadId,
  ThreadView,
  TurnId,
} from "@verdandi/contracts";
import { Context, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { flag, resolveHome, type ServerFile, serverFile } from "../config/home.ts";
import { connect } from "../rpc/client.ts";
import { approvalPrompt, type PendingRequest, parseAnswer, planPrompt, questionPrompt } from "./requests.ts";
import { describeRouteChange, routeFromFlags } from "./route-flags.ts";
import { threadList } from "./thread-list.ts";

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

const modeCommands = new Map<string, InteractionMode>([
  ["/ask", "ask"],
  ["/plan", "plan"],
  ["/build", "build"],
]);
const modeHelp: Record<InteractionMode, string> = {
  ask: "ask mode: the agent answers without changing anything",
  plan: "plan mode: the agent proposes a plan for you to approve before it changes anything",
  build: "build mode: the agent does the work",
};

/** Prints every thread from the projects feed's snapshot, then ends the feed (ADR 0008). */
const list = async (runtime: ManagedRuntime.ManagedRuntime<Client, never>, client: Client["Service"]) => {
  const subscriptionId = crypto.randomUUID();
  const snapshot = Promise.withResolvers<Extract<ProjectsFeed, { kind: "snapshot" }>>();
  const feed = runtime.runPromise(
    client
      .ProjectsSubscribe({ subscriptionId })
      .pipe(Stream.runForEach((f: ProjectsFeed) => Effect.sync(() => f.kind === "snapshot" && snapshot.resolve(f)))),
  );
  const noSnapshot = new Error("The projects feed ended before its snapshot arrived. Restart verdandid and try again.");
  feed.then(() => snapshot.reject(noSnapshot), snapshot.reject);
  const { projects, threads } = await snapshot.promise;
  await runtime.runPromise(client.Unsubscribe({ subscriptionId }));
  await feed;
  process.stdout.write(threadList(projects, threads));
};

/** Prints a `DiffGet` result, marking what was cut to keep the payload small. */
const diffText = (view: DiffView, projectPath: string) => {
  const cut = `[truncated: run git diff in ${projectPath} for the rest]\n`;
  const files = view.files.map((f) => `${f.diff}${f.diff.endsWith("\n") ? "" : "\n"}${f.truncated ? cut : ""}`);
  const omitted = view.omittedFiles ? `[${view.omittedFiles} more changed files not shown: run git diff in ${projectPath}]\n` : "";
  return files.length || omitted ? files.join("") + omitted : "[no changes]\n";
};

/** `verdandi chat`: a simple terminal chat with the thread for the current folder, or the one `--thread` names. */
export const chat = async (argv: readonly string[]) => {
  const home = resolveHome(argv);
  if (!existsSync(serverFile(home))) throw new Error(`verdandid is not running for ${home}. Start it with: verdandi start`);
  const server = JSON.parse(readFileSync(serverFile(home), "utf8")) as ServerFile;
  const route = routeFromFlags(argv); // also rejects bad flags before connecting
  const picked = flag(argv, "--thread") as ThreadId | undefined;

  const runtime = ManagedRuntime.make(Layer.effect(Client)(connect(server)));
  const client = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* Client;
    }),
  );
  if (argv.includes("--list")) {
    await list(runtime, client);
    return runtime.dispose();
  }
  const cwd = process.cwd();
  const threads = readThreads(home);
  let threadId = picked ?? (threads[cwd] as ThreadId | undefined);
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

  // Requests are answered one at a time, oldest first. `answered` collects the current user-input
  // request's answers, or holds the "n" of a plan rejection waiting for its feedback.
  const requests: PendingRequest[] = [];
  let answered: string[] = [];
  /** The turn a typed line steers; undefined while the thread is idle. */
  let running: TurnId | undefined;
  /** The thread's latest turn, which `/diff` shows. */
  let lastTurn: TurnId | undefined;
  /** The mode the next turn is sent in. */
  let mode: InteractionMode = "build";
  const snapshot = Promise.withResolvers<ThreadView>();
  let usage: Usage[] = [];
  const prompt = () => process.stdout.write(mode === "build" ? "> " : `${mode}> `);
  const showRequest = () => {
    const r = requests[0];
    if (!r) return;
    if (r.type === "approval.requested") process.stdout.write(approvalPrompt(r));
    else if (r.type === "plan.requested") {
      process.stdout.write(answered.length ? "Feedback for the agent to keep planning with (empty rejects without): " : planPrompt(r));
    } else {
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
            lastTurn = f.thread.turns.at(-1)?.turnId;
            requests.push(...f.thread.pendingRequests);
            snapshot.resolve(f.thread);
          }
          if (f.kind === "delta") process.stdout.write(f.text);
          if (f.kind !== "event") return;
          const e = f.stored.event;
          if (e.type === "turn.started") running = lastTurn = e.turnId;
          if (e.type === "approval.requested" || e.type === "user-input.requested" || e.type === "plan.requested") addRequest(e);
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
    if (request.type === "plan.requested") {
      if (answered.length) return resolve(request, line ? { decision: "deny", feedback: line } : { decision: "deny" });
      if (/^no?$/i.test(line)) {
        answered.push(line);
        return showRequest();
      }
      if (!/^y(es)?$/i.test(line)) return process.stdout.write("Answer y or n: ");
      // An approved plan goes on in build mode, and so do the turns after it.
      mode = "build";
      return resolve(request, { decision: "allow" });
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

  /** `/diff` shows what the last turn edited; `/diff all` everything that differs from HEAD in the project. */
  const showDiff = async (all: boolean, projectPath: string) => {
    if (!all && !lastTurn) return process.stdout.write("[no turns yet: /diff all shows the project's changes]\n");
    const text = await runtime.runPromise(
      client.DiffGet(all || !lastTurn ? { threadId } : { threadId, turnId: lastTurn }).pipe(
        Effect.map((view) => diffText(view, projectPath)),
        Effect.catchTag("DiffUnavailable", (e) => Effect.succeed(`${e.message}\n`)),
      ),
    );
    process.stdout.write(text);
  };

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
  mode = thread.turns.at(-1)?.mode ?? "build";
  // Flags that differ from the thread's route change it, from the next turn on.
  const wanted = routeFromFlags(argv, thread.route);
  const change = describeRouteChange(thread.route, wanted);
  const changed = change !== "" && (await dispatch({ type: "thread.route.set", commandId: uuid<CommandId>(), threadId, route: wanted }));
  const { harness, model, effort } = changed ? wanted : thread.route;
  process.stdout.write(
    `Thread ${threadId} in ${thread.projectPath} (${thread.turns.length} earlier turns) on ${harness} ${model} ${effort}, ${mode} mode. /ask, /plan and /build switch modes; /diff shows the last turn's edits, /diff all the project's; Ctrl+C stops a turn; /exit quits.\n`,
  );
  if (changed) process.stdout.write(`Route changed: ${change}\n`);
  if (running) process.stdout.write("A turn is running; lines you type steer it.\n");
  else prompt();
  showRequest();

  for await (const line of console) {
    const text = line.trim();
    const request = requests[0];
    const switchTo = modeCommands.get(text);
    if (request) await answer(request, text);
    else if (text === "/exit") break;
    else if (text === "/diff" || text === "/diff all") {
      await showDiff(text === "/diff all", thread.projectPath);
      if (!running) prompt();
    } else if (switchTo) {
      mode = switchTo;
      process.stdout.write(`[${modeHelp[mode]}${running ? "; applies from the next turn" : ""}]\n`);
      if (!running) prompt();
    } else if (!text) {
      if (!running) prompt();
    } else if (running && (await steer(running, text))) process.stdout.write("[steer sent: the agent reads it at its next step]\n");
    else {
      const turnId = uuid<TurnId>();
      running = turnId;
      if (!(await dispatch({ type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId, text, mode }))) {
        running = undefined;
        prompt();
      }
    }
  }
  await runtime.runPromise(client.Unsubscribe({ subscriptionId }));
  await feed;
  await runtime.dispose();
};
