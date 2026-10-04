import {
  type AttachmentUpload,
  type BudgetMode,
  type ClientCommand,
  type CommandId,
  capReached,
  type DiffView,
  describeCompression,
  describeRevertFiles,
  describeRouteChange,
  describeSpendCap,
  type InteractionMode,
  injectionItem,
  injectionLead,
  parseSlash,
  type Resolution,
  ratingWords,
  type SlashNameOn,
  slashEntry,
  slashHelp,
  type TaskId,
  type ThreadFeed,
  type ThreadId,
  type ThreadView,
  type TurnId,
} from "@verdandi/contracts";
import { Context, Effect, type ManagedRuntime, Stream } from "effect";
import { pairingLine } from "../devices/devices-cli.ts";
import { workspaceDir } from "../home/workspace.ts";
import type { connect } from "../rpc/client.ts";
import { skillsAction } from "../skills/skills-cli.ts";
import { readAttachment } from "./attach.ts";
import {
  approvalPrompt,
  editPlan,
  memoryPrompt,
  type PendingRequest,
  parseAnswer,
  planPrompt,
  questionPrompt,
  skillPrompt,
  trustedCommandsLine,
  trustPrompt,
} from "./requests.ts";
import { picksRoute, routeFromFlags } from "./route-flags.ts";

export class Client extends Context.Service<Client, Effect.Success<ReturnType<typeof connect>>>()("verdandi/cli/Client") {}

export const uuid = <T>() => crypto.randomUUID() as T;

type Usage = { model: string; accessMode: string; inputTokens: number; outputTokens: number; costUsd: number };

const summary = (status: string, error: string | undefined, usage: Usage[]) => {
  const parts = usage.map((u) => `${u.model} ${u.inputTokens}→${u.outputTokens} tok $${u.costUsd.toFixed(4)} ${u.accessMode}`);
  return `\n[${status}${error ? `: ${error}` : ""}${parts.length ? ` · ${parts.join(" · ")}` : ""}]\n`;
};

const modeHelp: Record<InteractionMode, string> = {
  ask: "ask mode: the agent answers without changing anything",
  plan: "plan mode: the agent proposes a plan for you to approve before it changes anything",
  build: "build mode: the agent does the work",
};

/** Prints a `DiffGet` result, marking what was cut to keep the payload small. */
const diffText = (view: DiffView, projectPath: string) => {
  const cut = `[truncated: run git diff in ${projectPath} for the rest]\n`;
  const files = view.files.map((f) => `${f.diff}${f.diff.endsWith("\n") ? "" : "\n"}${f.truncated ? cut : ""}`);
  const omitted = view.omittedFiles ? `[${view.omittedFiles} more changed files not shown: run git diff in ${projectPath}]\n` : "";
  return files.length || omitted ? files.join("") + omitted : "[no changes]\n";
};

/**
 * Where a chat session writes. The plain line chat writes to stdout; the terminal UI (`src/tui`) into its transcript.
 * `prompt` marks that the session waits for a new message in `mode`; `suspend` hands the terminal to another program
 * (the user's `$EDITOR`, for a plan edit) and takes it back after.
 */
export type Io = {
  readonly write: (text: string) => void;
  readonly prompt: (mode: InteractionMode) => void;
  readonly suspend: <A>(run: () => Promise<A>) => Promise<A>;
};

/** A chat on one thread, set up by `chat`: its client, and the flags that apply once its snapshot arrives. */
export type SessionSetup = {
  readonly runtime: ManagedRuntime.ManagedRuntime<Client, never>;
  readonly client: Client["Service"];
  readonly threadId: ThreadId;
  readonly home: string;
  readonly argv: readonly string[];
  /** The thread `--thread` named, if any. */
  readonly picked: ThreadId | undefined;
  readonly worktree: boolean;
  readonly budget: BudgetMode | null | undefined;
};

/**
 * Follows the thread's feed and writes what happens to `io`, as lines both terminal surfaces share, and returns how
 * typed lines (`input`) and Ctrl+C (`interrupt`) drive it. `notes` are written first.
 */
export const openSession = async (setup: SessionSetup, io: Io, notes: readonly string[]) => {
  const { runtime, client, threadId, home, argv, picked, worktree, budget } = setup;
  for (const note of notes) io.write(note);
  const dispatch = (command: ClientCommand) =>
    runtime.runPromise(
      client.CommandDispatch(command).pipe(
        Effect.as(true),
        Effect.catchTag("CommandRejected", (e) => Effect.sync(() => io.write(`${e.message}\n`)).pipe(Effect.as(false))),
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
  /** The thread's latest task, which `/rate` rates. */
  let lastTask: TaskId | undefined;
  /** The mode the next turn is sent in. */
  let mode: InteractionMode = "build";
  /** Files `/attach` read, which go with the next turn. */
  let attached: AttachmentUpload[] = [];
  const snapshot = Promise.withResolvers<ThreadView>();
  let usage: Usage[] = [];
  const prompt = () => io.prompt(mode);
  const showRequest = () => {
    const r = requests[0];
    if (!r) return;
    if (r.type === "approval.requested") io.write(approvalPrompt(r));
    else if (r.type === "skill.proposed") io.write(skillPrompt(r));
    else if (r.type === "memory.proposed") io.write(memoryPrompt(r));
    else if (r.type === "commands.trust.requested") io.write(trustPrompt(r));
    else if (r.type === "plan.requested") {
      io.write(answered.length ? "Feedback for the agent to keep planning with (empty rejects without): " : planPrompt(r));
    } else {
      const next = r.questions[answered.length];
      if (next) io.write(questionPrompt(next));
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
            lastTask = f.thread.tasks.at(-1)?.taskId;
            shown.push(...f.thread.turns.filter((t) => !t.reverted).map((t) => t.turnId));
            requests.push(...f.thread.pendingRequests);
            snapshot.resolve(f.thread);
          }
          if (f.kind === "delta") io.write(f.text);
          if (f.kind !== "event") return;
          const e = f.stored.event;
          if (e.type === "task.started") lastTask = e.taskId;
          // A pinned thread's tasks need no line; one a message pinned with `@name` gets one.
          if (e.type === "task.started" && e.decision && (e.decision.source !== "pin" || e.inputs?.at)) {
            const how = e.decision.source === "pin" ? "pinned" : "routed";
            io.write(`[${how} to ${e.route.model} ${e.route.effort} on ${e.route.harness}: ${e.decision.reason}]\n`);
          }
          if (e.type === "task.rerouted") {
            io.write(`[plan approved: the build runs on ${e.to.model} ${e.to.effort}: ${e.decision.reason}]\n`);
          }
          if (e.type === "turn.effort.set") io.write(`[${e.to} effort for this turn: ${e.reason}]\n`);
          if (e.type === "task.delegated") io.write(`\n[delegated a subtask to ${e.to.model} ${e.to.effort}: ${e.decision.reason}]\n`);
          if (e.type === "turn.rerouted") io.write(`[fell back to ${e.to.model} ${e.to.effort} for this turn: ${e.reason}]\n`);
          if (e.type === "task.deescalated") {
            io.write(`[de-escalated to ${e.to.model} ${e.to.effort}: ${e.decision.reason}]\n`);
          }
          if (e.type === "verifier.ran") {
            const result = e.passed ? "passed" : `failed${e.exitCode === null ? "" : ` (exit ${e.exitCode})`}`;
            const tail = e.passed ? "" : `${e.output.trimEnd().split(/\r?\n/).slice(-10).join("\n")}\n`;
            io.write(`\n[verifier ${e.command} ${result} in ${(e.durationMs / 1000).toFixed(1)}s]\n${tail}`);
          }
          if (e.type === "task.blocked") io.write(`\n[the agent is blocked: ${e.reason}]\n`);
          if (e.type === "injection.flagged") {
            const item = injectionItem(e);
            io.write(`\n[${injectionLead(item)} ${item.why}]\n`);
          }
          if (e.type === "task.escalated") {
            const moved = e.to ? `escalated to ${e.to.model} ${e.to.effort}` : "not escalated";
            // The way back is picking the route it escalated from, which pins the thread like any route pick.
            const undo = e.to ? ` To undo it: verdandi chat --thread ${threadId} --model ${e.from.model} --effort ${e.from.effort}` : "";
            io.write(`[${moved}: ${e.reason}${undo}]\n`);
          }
          if (e.type === "thread.reverted") {
            const n = shown.indexOf(e.toTurnId) + 1;
            shown = shown.filter((t) => !e.turnIds.includes(t));
            io.write(
              `[reverted the conversation${e.files ? " and files" : ""} to turn ${n}: the next turn continues from there; /undo-revert undoes it]\n`,
            );
          }
          if (e.type === "thread.revert.undone") {
            shown = [...shown, ...e.turnIds];
            io.write("[revert undone]\n");
          }
          if (e.type === "thread.files.restored") {
            const notes = [...(e.error ? [`files not restored: ${e.error}`] : []), ...describeRevertFiles(e)];
            io.write(notes.map((note) => `[${note}]\n`).join(""));
          }
          if (e.type === "thread.worktree.created") io.write(`[worktree ready at ${e.path}]\n`);
          if (e.type === "thread.worktree.failed") io.write(`[worktree: ${e.error}]\n`);
          if (e.type === "thread.worktree.setup.ran") {
            const tail = e.passed ? "" : `${e.output.trimEnd().split(/\r?\n/).slice(-10).join("\n")}\n`;
            io.write(`[worktree setup ${e.command} ${e.passed ? "passed" : "failed"}]\n${tail}`);
          }
          if (e.type === "thread.worktree.removed") io.write("[worktree removed; its branch is kept]\n");
          if (e.type === "turn.started") {
            running = lastTurn = e.turnId;
            shown.push(e.turnId);
          }
          if (
            e.type === "approval.requested" ||
            e.type === "user-input.requested" ||
            e.type === "plan.requested" ||
            e.type === "skill.proposed" ||
            e.type === "memory.proposed" ||
            e.type === "commands.trust.requested"
          )
            addRequest(e);
          if (e.type === "turn.item.added" && e.item.kind === "notice") io.write(`\n[${e.item.text}]\n`);
          if (e.type === "turn.item.added" && e.item.kind === "approval.auto")
            io.write(`\n[${e.item.decision === "allow" ? "auto-approved" : "refused"} by smart approvals: ${e.item.reason}]\n`);
          if (e.type === "turn.item.added" && e.item.kind === "compression") io.write(`\n[${describeCompression(e.item)}]\n`);
          if (e.type === "turn.item.added" && e.item.kind === "handoff")
            io.write(
              `\n[handed over from ${e.item.from} to a new ${e.item.to} session, with this summary of the thread so far:]\n${e.item.summary}\n`,
            );
          if (e.type === "thread.worktree.setup.held")
            io.write(`[worktree setup ${e.command} waits for you to trust it; the next turn asks]\n`);
          if (e.type === "skill.applied") io.write(e.error ? `[skill not written: ${e.error}]\n` : `[skill ${e.skill} saved]\n`);
          if (e.type === "approval.resolved") removeRequest(e.requestId);
          if (e.type === "turn.usage.recorded") usage.push(e);
          if (e.type === "turn.completed") {
            io.write(summary(e.status, e.error, usage));
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
    if (
      request.type === "approval.requested" ||
      request.type === "skill.proposed" ||
      request.type === "memory.proposed" ||
      request.type === "commands.trust.requested"
    ) {
      const yes = /^y(es)?$/i.test(line);
      if (yes || /^no?$/i.test(line)) return resolve(request, { decision: yes ? "allow" : "deny" });
      return io.write("Answer y or n: ");
    }
    if (request.type === "plan.requested") {
      if (answered.length) return resolve(request, line ? { decision: "deny", feedback: line } : { decision: "deny" });
      if (/^no?$/i.test(line)) {
        answered.push(line);
        return showRequest();
      }
      // The plan opens in the user's editor; what they save is what the agent builds from.
      const edited = /^e(dit)?$/i.test(line) ? await io.suspend(() => editPlan(request.plan)) : undefined;
      if (edited && "error" in edited) return io.write(`[${edited.error}]\nAnswer y, n or e: `);
      if (!edited && !/^y(es)?$/i.test(line)) return io.write("Answer y, n or e: ");
      // An approved plan goes on in build mode, and so do the turns after it.
      mode = "build";
      return resolve(request, edited ? { decision: "allow", plan: edited.plan } : { decision: "allow" });
    }
    const question = request.questions[answered.length];
    const picked = question && parseAnswer(question, line);
    if (!question || picked === undefined) return showRequest();
    answered.push(picked);
    if (answered.length < request.questions.length) return showRequest();
    const answers = Object.fromEntries(request.questions.map((q, i) => [q.question, answered[i] ?? ""]));
    return resolve(request, { decision: "answer", answers });
  };

  /**
   * Steers the running turn, saying whether it went or why not. False when that turn finished first, so the line goes
   * out as the next turn.
   */
  const steer = (turnId: TurnId, text: string) =>
    runtime.runPromise(
      client.CommandDispatch({ type: "turn.steer", commandId: uuid<CommandId>(), threadId, turnId, text }).pipe(
        Effect.andThen(Effect.sync(() => io.write("[steer sent: the agent reads it at its next step]\n"))),
        Effect.as(true),
        Effect.catchTag("CommandRejected", (e) =>
          e.reason === "TurnNotRunning" ? Effect.succeed(false) : Effect.sync(() => io.write(`${e.message}\n`)).pipe(Effect.as(true)),
        ),
      ),
    );

  /** `/diff` shows what the last turn changed; `/diff all` everything since the thread's first turn. */
  const showDiff = async (all: boolean, projectPath: string) => {
    if (!all && !lastTurn) return io.write("[no turns yet: /diff all shows the project's changes]\n");
    const text = await runtime.runPromise(
      client.DiffGet(all || !lastTurn ? { threadId } : { threadId, turnId: lastTurn }).pipe(
        Effect.map((view) => diffText(view, projectPath)),
        Effect.catchTag("DiffUnavailable", (e) => Effect.succeed(`${e.message}\n`)),
      ),
    );
    io.write(text);
  };

  // Ctrl+C interrupts the running turn. A second Ctrl+C before it ends, or one at the prompt, quits: then this says true.
  let interrupting: TurnId | undefined;
  const interrupt = () => {
    if (!running || interrupting === running) return true;
    interrupting = running;
    io.write("\n[interrupting: Ctrl+C again to quit]\n");
    void dispatch({ type: "turn.interrupt", commandId: uuid<CommandId>(), threadId, turnId: running });
    return false;
  };

  /** How close the thread's project and profile are to their spend caps; `raise` first raises each reached one for the rest of its period. */
  const showSpendCaps = async (raise: boolean) => {
    const get = () =>
      runtime.runPromise(client.SpendCapsGet({ threadId }).pipe(Effect.catchTag("SpendCapsUnavailable", (e) => Effect.succeed(e.message))));
    const caps = await get();
    if (typeof caps === "string") return io.write(`${caps}\n`);
    const reached = raise ? caps.filter(capReached) : [];
    for (const cap of reached) {
      await dispatch({ type: "spend.cap.raise", commandId: uuid<CommandId>(), threadId, scope: cap.scope, period: cap.period });
    }
    if (raise && reached.length === 0) io.write("No spend cap is reached, so none was raised.\n");
    const shown = reached.length > 0 ? await get() : caps;
    for (const cap of typeof shown === "string" ? [] : shown) {
      const hint = capReached(cap) ? " (reached: --raise-cap raises it for the rest of the period)" : "";
      io.write(`Spend: ${describeSpendCap(cap)}${hint}\n`);
    }
  };

  /** Whether smart approvals rate the native agent's commands (DESIGN §17), when `approvals.yaml` enables them, and how to switch. */
  const showSmartApprovals = async () => {
    const smart = await runtime.runPromise(client.ApprovalsGet());
    if (smart.enabled)
      io.write(
        smart.on
          ? "Smart approvals: on, so commands they rate safe run without asking (/smart off turns them off).\n"
          : "Smart approvals: off, so every command asks (/smart on turns them back on).\n",
      );
  };

  // A device asking to pair gets a notice once, with the code it shows and how to answer (ADR 0028).
  const devicesSubscription = crypto.randomUUID();
  const noticed = new Set<string>();
  const devicesFeed = runtime.runPromise(
    client.DevicesSubscribe({ subscriptionId: devicesSubscription }).pipe(
      Stream.runForEach((view) =>
        Effect.sync(() => {
          for (const r of view.pending) {
            if (noticed.has(r.requestId)) continue;
            noticed.add(r.requestId);
            io.write(`\n[${pairingLine(r)}]\n`);
          }
        }),
      ),
    ),
  );

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
  io.write(
    `Thread ${threadId} in ${thread.projectPath === workspaceDir(home) ? `the workspace (${thread.projectPath}; --here works on the current folder instead)` : thread.projectPath} (${thread.turns.length} earlier turns) on ${on}, ${mode} mode. Start a message with @opus (or another model) to pin the task it starts to it; /help lists the commands; Ctrl+C stops a turn; /exit quits.\n`,
  );
  const tree = thread.worktree;
  if (tree) {
    const where = tree.path ? ` at ${tree.path}` : "";
    io.write(`Worktree on branch ${tree.branch}${where}: ${tree.state}${tree.error ? `. ${tree.error}` : ""}\n`);
  }
  if (picked && worktree) await dispatch({ type: "thread.worktree.add", commandId: uuid<CommandId>(), threadId });
  if (argv.includes("--remove-worktree")) {
    const force = argv.includes("--force");
    await dispatch({ type: "thread.worktree.remove", commandId: uuid<CommandId>(), threadId, force });
  }
  if (thread.archived) {
    io.write(`This thread is archived, so turns are rejected. Unarchive it with: verdandi chat --unarchive ${threadId}\n`);
  }
  if (changed) io.write(change ? `Route changed: ${change}\n` : `Route pinned: ${harness} ${model} ${effort}\n`);
  if (unpinned) io.write("Route unpinned: the router picks the next task's route.\n");
  if (budget !== undefined && budget !== thread.budgetMode) {
    await dispatch({ type: "thread.budget.set", commandId: uuid<CommandId>(), threadId, mode: budget });
    const which = budget === null ? "the routing policy's" : budget;
    const pinnedNow = (thread.pinned && !unpinned) || changed;
    io.write(
      `Budget mode: ${which}, ${pinnedNow ? "once the router picks again (--auto)" : "from the next turn, which starts a new task"}.\n`,
    );
  }
  await showSpendCaps(argv.includes("--raise-cap"));
  await showSmartApprovals();
  if (running) io.write("A turn is running; lines you type steer it.\n");
  else prompt();
  showRequest();

  /** `/revert` drops the latest turn; `/revert <n>` goes back to the end of turn n; `files` restores the files too. */
  const revert = async (args: readonly string[]) => {
    const files = args.includes("files");
    const n = Number(args.find((a) => a !== "files") ?? shown.length - 1);
    const toTurnId = shown[n - 1];
    if (!toTurnId || !Number.isInteger(n)) io.write(`[usage: /revert [n] [files], with n from 1 to ${shown.length - 1}]\n`);
    else await dispatch({ type: "thread.revert", commandId: uuid<CommandId>(), threadId, toTurnId, files });
  };

  /** The project's trusted command lists, numbered as `/trusted` lists them; `/untrust <n>` revokes one. */
  const trusted = async (revokeAt: string | undefined) => {
    const lists = await runtime.runPromise(client.TrustedCommandsList({ threadId }));
    if (revokeAt === undefined)
      return io.write(
        lists.length === 0
          ? "[this project trusts none of its own commands yet; Verdandi asks before it runs them]\n"
          : `${lists.map((t, i) => `  ${i + 1}. ${trustedCommandsLine(t)}`).join("\n")}\n[/untrust <n> revokes one]\n`,
      );
    const revoke = lists[Number(revokeAt) - 1];
    if (!revoke) io.write(`[usage: /untrust <n>, with n from /trusted (1 to ${lists.length})]\n`);
    else if (await dispatch({ type: "commands.trust.revoke", commandId: uuid<CommandId>(), threadId, hash: revoke.hash }))
      io.write("[revoked: Verdandi asks again before it runs those commands or starts an agent with those files]\n");
  };

  const switchMode = (to: InteractionMode) => () => {
    mode = to;
    io.write(`[${modeHelp[mode]}${running ? "; applies from the next turn" : ""}]\n`);
  };

  /** What `/exit`'s handler returns; any other result, such as a write's, keeps the chat open. */
  const quit = Symbol("quit");
  /** Each slash command of the terminal chat (`slashCommands`), given the words after its name. */
  const commands: Record<SlashNameOn<"chat">, (args: readonly string[]) => unknown> = {
    help: () =>
      io.write(
        `${slashHelp("chat")}\nStart a message with @opus (or another model) to pin the task it starts to it; Ctrl+C stops a turn.\n`,
      ),
    ask: switchMode("ask"),
    plan: switchMode("plan"),
    build: switchMode("build"),
    attach: (args) => {
      const read = readAttachment(args.join(" "), process.cwd());
      if (typeof read === "string") return io.write(`${read}\n`);
      attached.push(read);
      const names = attached.map((a) => a.name).join(", ");
      io.write(
        `[attached ${read.name}; ${names} go${attached.length === 1 ? "es" : ""} with your next message${running ? ", after this turn" : ""}. /detach drops them]\n`,
      );
    },
    detach: () => {
      io.write(attached.length ? `[dropped ${attached.map((a) => a.name).join(", ")}]\n` : "[nothing attached]\n");
      attached = [];
    },
    diff: (args) => showDiff(args[0] === "all", thread.projectPath),
    skip: () => {
      const request = requests[0];
      if (request?.type !== "user-input.requested") return io.write("[/skip declines the agent's question, and none is waiting]\n");
      return resolve(request, { decision: "deny" });
    },
    rate: async (args) => {
      const word = args[0] ?? "";
      const rating = ratingWords.get(word);
      if (rating === undefined) io.write("[usage: /rate up|down|clear]\n");
      else if (!lastTask) io.write("[this thread has no task to rate yet]\n");
      else if (await dispatch({ type: "task.rate", commandId: uuid<CommandId>(), threadId, taskId: lastTask, rating }))
        io.write(rating === null ? "[rating cleared]\n" : `[rated the latest task ${word}]\n`);
    },
    "forget-routing": async () => {
      if (await dispatch({ type: "routing.memory.clear", commandId: uuid<CommandId>(), threadId }))
        io.write("[routing memory cleared: this project's next routed tasks go by the policy alone]\n");
    },
    revert,
    "undo-revert": () => dispatch({ type: "thread.revert.undo", commandId: uuid<CommandId>(), threadId }),
    smart: async (args) => {
      const on = args[0] === "on" ? true : args[0] === "off" ? false : undefined;
      if (on === undefined) io.write("[usage: /smart on|off]\n");
      else if (await dispatch({ type: "approvals.smart.set", commandId: uuid<CommandId>(), on })) await showSmartApprovals();
    },
    trusted: () => trusted(undefined),
    untrust: (args) => trusted(args[0] ?? ""),
    // The Skills panel's controls: list with pins, a skill's history, revert, pin, unpin and restore.
    skills: async (args) => io.write(await runtime.runPromise(skillsAction(client, args))),
    exit: () => quit,
  };

  /**
   * Handles one typed line: a slash command runs (or is refused while a turn runs, as `slashCommands` says) without
   * answering the waiting request; any other line answers that request, steers the running turn or sends a new one.
   * True on `/exit`.
   */
  const input = async (line: string) => {
    const text = line.trim();
    const request = requests[0];
    const command = parseSlash(text, "chat");
    if (command) {
      const busy = slashEntry(command.name).whileBusy;
      if (running && typeof busy === "object") io.write(`[${busy.refuse}]\n`);
      else if ((await commands[command.name](command.args)) === quit) return true;
      // The request still waits, so say again what a typed line answers.
      if (request && requests[0] === request) showRequest();
      else if (!running && !requests[0]) prompt();
    } else if (request) await answer(request, text);
    else if (!text) {
      if (!running) prompt();
    } else if (!running || !(await steer(running, text))) {
      const turnId = uuid<TurnId>();
      running = turnId;
      const attachments = attached.length > 0 ? { attachments: attached } : {};
      if (!(await dispatch({ type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId, text, mode, ...attachments }))) {
        running = undefined;
        prompt();
      } else attached = [];
    }
    return false;
  };

  /** Ends the thread feed; the caller then disposes the client and any verdandid it started. */
  const close = async () => {
    await runtime.runPromise(client.Unsubscribe({ subscriptionId }));
    await runtime.runPromise(client.Unsubscribe({ subscriptionId: devicesSubscription }));
    await Promise.all([feed, devicesFeed]);
  };
  return {
    input,
    interrupt,
    close,
    /** What a richer surface shows beside the transcript: the mode, whether a turn runs, and the request a typed line answers. */
    state: () => ({ mode, running: running !== undefined, request: requests[0], attached: attached.map((a) => a.name) }),
  };
};

export type Session = Awaited<ReturnType<typeof openSession>>;
