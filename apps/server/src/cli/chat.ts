import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AttachmentUpload,
  type ClientCommand,
  type CommandId,
  capReached,
  type DiffView,
  describeRouteChange,
  describeSpendCap,
  type InteractionMode,
  type ProjectsFeed,
  type Resolution,
  type ThreadFeed,
  type ThreadId,
  type ThreadView,
  type TurnId,
} from "@verdandi/contracts";
import { Context, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { flag, readServerFile, resolveHome } from "../config/home.ts";
import { connect } from "../rpc/client.ts";
import { readAttachment } from "./attach.ts";
import { approvalPrompt, type PendingRequest, parseAnswer, planPrompt, questionPrompt } from "./requests.ts";
import { budgetFromFlags, picksRoute, routeFromFlags } from "./route-flags.ts";
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

/** Prints every thread from the projects feed's snapshot, archived ones only with `archived`, then ends the feed (ADR 0008). */
const list = async (runtime: ManagedRuntime.ManagedRuntime<Client, never>, client: Client["Service"], archived: boolean) => {
  const subscriptionId = crypto.randomUUID();
  const snapshot = Promise.withResolvers<Extract<ProjectsFeed, { kind: "snapshot" }>>();
  const feed = runtime.runPromise(
    client
      .ProjectsSubscribe({ subscriptionId, archived })
      .pipe(Stream.runForEach((f: ProjectsFeed) => Effect.sync(() => f.kind === "snapshot" && snapshot.resolve(f)))),
  );
  const noSnapshot = new Error("The projects feed ended before its snapshot arrived. Restart verdandid and try again.");
  feed.then(() => snapshot.reject(noSnapshot), snapshot.reject);
  const { projects, threads, quotas } = await snapshot.promise;
  await runtime.runPromise(client.Unsubscribe({ subscriptionId }));
  await feed;
  process.stdout.write(threadList(projects, threads, quotas));
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
  const server = readServerFile(home);
  const route = routeFromFlags(argv); // also rejects bad flags before connecting
  const budget = budgetFromFlags(argv);
  if (argv.includes("--auto") && picksRoute(argv)) {
    throw new Error("--auto lets the router pick each task's route, so leave out --harness, --model and --effort.");
  }
  const picked = flag(argv, "--thread") as ThreadId | undefined;

  const runtime = ManagedRuntime.make(Layer.effect(Client)(connect(server)));
  const client = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* Client;
    }),
  );
  if (argv.includes("--list")) {
    await list(runtime, client, argv.includes("--archived"));
    return runtime.dispose();
  }
  // Archiving hides a thread from the lists without deleting anything; unarchiving brings it back.
  const archive = flag(argv, "--archive") as ThreadId | undefined;
  const unarchive = flag(argv, "--unarchive") as ThreadId | undefined;
  const put = archive ?? unarchive;
  if (put) {
    const type = archive ? "thread.archive" : "thread.unarchive";
    const done = archive
      ? `Archived thread ${put}. \`verdandi chat --unarchive ${put}\` brings it back; \`verdandi chat --list --archived\` lists it.\n`
      : `Unarchived thread ${put}: it takes turns again.\n`;
    process.stdout.write(
      await runtime.runPromise(
        client.CommandDispatch({ type, commandId: uuid<CommandId>(), threadId: put }).pipe(
          Effect.as(done),
          Effect.catchTag("CommandRejected", (e) => Effect.succeed(`${e.message}\n`)),
        ),
      ),
    );
    return runtime.dispose();
  }
  const cwd = process.cwd();
  const threads = readThreads(home);
  // --worktree starts a new thread in a worktree of its own; with --thread, it recreates that thread's worktree.
  const worktree = argv.includes("--worktree");
  let threadId = picked ?? (worktree ? undefined : (threads[cwd] as ThreadId | undefined));
  if (!threadId) {
    threadId = uuid<ThreadId>();
    await runtime.runPromise(
      client.CommandDispatch({
        type: "thread.create",
        commandId: uuid<CommandId>(),
        threadId,
        projectPath: cwd,
        ...(picksRoute(argv) ? { route } : {}),
        ...(worktree && { worktree }),
      }),
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
  /** The turns still in the conversation, oldest first: `/revert <n>` counts them. */
  let shown: TurnId[] = [];
  /** The thread's latest turn, which `/diff` shows. */
  let lastTurn: TurnId | undefined;
  /** The mode the next turn is sent in. */
  let mode: InteractionMode = "build";
  /** Files `/attach` read, which go with the next turn. */
  let attached: AttachmentUpload[] = [];
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
            shown.push(...f.thread.turns.filter((t) => !t.reverted).map((t) => t.turnId));
            requests.push(...f.thread.pendingRequests);
            snapshot.resolve(f.thread);
          }
          if (f.kind === "delta") process.stdout.write(f.text);
          if (f.kind !== "event") return;
          const e = f.stored.event;
          // A pinned thread's tasks need no line; one a message pinned with `@name` gets one.
          if (e.type === "task.started" && e.decision && (e.decision.source !== "pin" || e.inputs?.at)) {
            const how = e.decision.source === "pin" ? "pinned" : "routed";
            process.stdout.write(`[${how} to ${e.route.model} ${e.route.effort} on ${e.route.harness}: ${e.decision.reason}]\n`);
          }
          if (e.type === "task.rerouted") {
            process.stdout.write(`[plan approved: the build runs on ${e.to.model} ${e.to.effort}: ${e.decision.reason}]\n`);
          }
          if (e.type === "verifier.ran") {
            const result = e.passed ? "passed" : `failed${e.exitCode === null ? "" : ` (exit ${e.exitCode})`}`;
            const tail = e.passed ? "" : `${e.output.trimEnd().split(/\r?\n/).slice(-10).join("\n")}\n`;
            process.stdout.write(`\n[verifier ${e.command} ${result} in ${(e.durationMs / 1000).toFixed(1)}s]\n${tail}`);
          }
          if (e.type === "task.blocked") process.stdout.write(`\n[the agent is blocked: ${e.reason}]\n`);
          if (e.type === "task.escalated") {
            const moved = e.to ? `escalated to ${e.to.model} ${e.to.effort}` : "not escalated";
            process.stdout.write(`[${moved}: ${e.reason}]\n`);
          }
          if (e.type === "thread.reverted") {
            const n = shown.indexOf(e.toTurnId) + 1;
            shown = shown.filter((t) => !e.turnIds.includes(t));
            process.stdout.write(
              `[reverted the conversation${e.files ? " and files" : ""} to turn ${n}: the next turn continues from there; /undo-revert undoes it]\n`,
            );
          }
          if (e.type === "thread.revert.undone") {
            shown = [...shown, ...e.turnIds];
            process.stdout.write("[revert undone]\n");
          }
          if (e.type === "thread.files.restored" && e.error) process.stdout.write(`[files not restored: ${e.error}]\n`);
          if (e.type === "thread.worktree.created") process.stdout.write(`[worktree ready at ${e.path}]\n`);
          if (e.type === "thread.worktree.failed") process.stdout.write(`[worktree: ${e.error}]\n`);
          if (e.type === "thread.worktree.setup.ran") {
            const tail = e.passed ? "" : `${e.output.trimEnd().split(/\r?\n/).slice(-10).join("\n")}\n`;
            process.stdout.write(`[worktree setup ${e.command} ${e.passed ? "passed" : "failed"}]\n${tail}`);
          }
          if (e.type === "thread.worktree.removed") process.stdout.write("[worktree removed; its branch is kept]\n");
          if (e.type === "turn.started") {
            running = lastTurn = e.turnId;
            shown.push(e.turnId);
          }
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

  /** `/diff` shows what the last turn changed; `/diff all` everything since the thread's first turn. */
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

  /** How close the thread's project and profile are to their spend caps; `raise` first raises each reached one for the rest of its period. */
  const showSpendCaps = async (raise: boolean) => {
    const get = () =>
      runtime.runPromise(client.SpendCapsGet({ threadId }).pipe(Effect.catchTag("SpendCapsUnavailable", (e) => Effect.succeed(e.message))));
    const caps = await get();
    if (typeof caps === "string") return process.stdout.write(`${caps}\n`);
    const reached = raise ? caps.filter(capReached) : [];
    for (const cap of reached) {
      await dispatch({ type: "spend.cap.raise", commandId: uuid<CommandId>(), threadId, scope: cap.scope, period: cap.period });
    }
    if (raise && reached.length === 0) process.stdout.write("No spend cap is reached, so none was raised.\n");
    const shown = reached.length > 0 ? await get() : caps;
    for (const cap of typeof shown === "string" ? [] : shown) {
      const hint = capReached(cap) ? " (reached: --raise-cap raises it for the rest of the period)" : "";
      process.stdout.write(`Spend: ${describeSpendCap(cap)}${hint}\n`);
    }
  };

  const noSnapshot = new Error("The thread feed ended before its snapshot arrived. Restart verdandid and try again.");
  feed.then(() => snapshot.reject(noSnapshot), snapshot.reject);
  const thread = await snapshot.promise;
  mode = thread.turns.at(-1)?.mode ?? "build";
  // Route flags pin the thread to their route from the next turn on; --auto hands it back to the router.
  const wanted = routeFromFlags(argv, thread.route);
  const change = describeRouteChange(thread.route, wanted);
  const pin = picksRoute(argv) && (change !== "" || !thread.pinned);
  const changed = pin && (await dispatch({ type: "thread.route.set", commandId: uuid<CommandId>(), threadId, route: wanted }));
  const unpinned =
    argv.includes("--auto") && thread.pinned && (await dispatch({ type: "thread.route.unpin", commandId: uuid<CommandId>(), threadId }));
  const { harness, model, effort } = changed ? wanted : thread.route;
  const on =
    changed || (thread.pinned && !unpinned)
      ? `${harness} ${model} ${effort} (pinned; --auto lets the router pick)`
      : thread.task && !unpinned
        ? `${harness} ${model} ${effort} (routed; --model or --effort pins a route)`
        : "the route the router picks for the next task";
  process.stdout.write(
    `Thread ${threadId} in ${thread.projectPath} (${thread.turns.length} earlier turns) on ${on}, ${mode} mode. Start a message with @opus (or another model) to pin the task it starts to it; /ask, /plan and /build switch modes; /diff shows the last turn's edits, /diff all the project's; /attach <path> sends a file or image with your next message, /detach drops them; /forget-routing clears what the router learned from this project's tasks; /revert [n] [files] goes back to the end of turn n (default: drops the latest turn), with its files too, and /undo-revert undoes that; Ctrl+C stops a turn; /exit quits.\n`,
  );
  const tree = thread.worktree;
  if (tree) {
    const where = tree.path ? ` at ${tree.path}` : "";
    process.stdout.write(`Worktree on branch ${tree.branch}${where}: ${tree.state}${tree.error ? `. ${tree.error}` : ""}\n`);
  }
  if (picked && worktree) await dispatch({ type: "thread.worktree.add", commandId: uuid<CommandId>(), threadId });
  if (argv.includes("--remove-worktree")) {
    const force = argv.includes("--force");
    await dispatch({ type: "thread.worktree.remove", commandId: uuid<CommandId>(), threadId, force });
  }
  if (thread.archived) {
    process.stdout.write(`This thread is archived, so turns are rejected. Unarchive it with: verdandi chat --unarchive ${threadId}\n`);
  }
  if (changed) process.stdout.write(change ? `Route changed: ${change}\n` : `Route pinned: ${harness} ${model} ${effort}\n`);
  if (unpinned) process.stdout.write("Route unpinned: the router picks the next task's route.\n");
  if (budget !== undefined && budget !== thread.budgetMode) {
    await dispatch({ type: "thread.budget.set", commandId: uuid<CommandId>(), threadId, mode: budget });
    const which = budget === null ? "the routing policy's" : budget;
    const pinnedNow = (thread.pinned && !unpinned) || changed;
    process.stdout.write(
      `Budget mode: ${which}, ${pinnedNow ? "once the router picks again (--auto)" : "from the next turn, which starts a new task"}.\n`,
    );
  }
  await showSpendCaps(argv.includes("--raise-cap"));
  if (running) process.stdout.write("A turn is running; lines you type steer it.\n");
  else prompt();
  showRequest();

  for await (const line of console) {
    const text = line.trim();
    const request = requests[0];
    const switchTo = modeCommands.get(text);
    if (request) await answer(request, text);
    else if (text === "/exit") break;
    else if (text === "/attach" || text.startsWith("/attach ")) {
      const read = readAttachment(text.slice("/attach".length), cwd);
      if (typeof read === "string") process.stdout.write(`${read}\n`);
      else {
        attached.push(read);
        const names = attached.map((a) => a.name).join(", ");
        process.stdout.write(
          `[attached ${read.name}; ${names} go${attached.length === 1 ? "es" : ""} with your next message${running ? ", after this turn" : ""}. /detach drops them]\n`,
        );
      }
      if (!running) prompt();
    } else if (text === "/detach") {
      process.stdout.write(attached.length ? `[dropped ${attached.map((a) => a.name).join(", ")}]\n` : "[nothing attached]\n");
      attached = [];
      if (!running) prompt();
    } else if (/^\/revert(\s|$)/.test(text)) {
      // `/revert` drops the latest turn; `/revert <n>` goes back to the end of turn n; `files` restores the files too.
      const args = text.split(/\s+/).slice(1);
      const files = args.includes("files");
      const n = Number(args.find((a) => a !== "files") ?? shown.length - 1);
      const toTurnId = shown[n - 1];
      if (!toTurnId || !Number.isInteger(n)) process.stdout.write(`[usage: /revert [n] [files], with n from 1 to ${shown.length - 1}]\n`);
      else await dispatch({ type: "thread.revert", commandId: uuid<CommandId>(), threadId, toTurnId, files });
      if (!running) prompt();
    } else if (text === "/undo-revert") {
      await dispatch({ type: "thread.revert.undo", commandId: uuid<CommandId>(), threadId });
      if (!running) prompt();
    } else if (text === "/forget-routing") {
      if (await dispatch({ type: "routing.memory.clear", commandId: uuid<CommandId>(), threadId }))
        process.stdout.write("[routing memory cleared: this project's next routed tasks go by the policy alone]\n");
      if (!running) prompt();
    } else if (text === "/diff" || text === "/diff all") {
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
      const attachments = attached.length > 0 ? { attachments: attached } : {};
      if (!(await dispatch({ type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId, text, mode, ...attachments }))) {
        running = undefined;
        prompt();
      } else attached = [];
    }
  }
  await runtime.runPromise(client.Unsubscribe({ subscriptionId }));
  await feed;
  await runtime.dispose();
};
