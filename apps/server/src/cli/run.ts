import { resolve } from "node:path";
import {
  type ClientCommand,
  type CommandId,
  clip,
  describeCost,
  describeRouteChange,
  type Event,
  InteractionMode,
  type Route,
  type SpendSplit,
  type TaskId,
  type ThreadFeed,
  type ThreadId,
  type TurnId,
  type Usage,
  type VerifierRun,
} from "@verdandi/contracts";
import { Effect, Fiber, Queue, Schema, Stream } from "effect";
import { parseBatchRoute } from "../batch/batch.ts";
import { flag, readServerFile, resolveHome, type ServerFile } from "../home/home.ts";
import { expandHome } from "../projects/project.ts";
import { connect } from "../rpc/client.ts";
import { spendSplit } from "../spend/usage.ts";
import { type PendingRequest, skillChangeTitle } from "./requests.ts";

/** How `verdandi run` ends, as its usage line in `bin.ts` documents. Any other error (verdandid not running, the turn rejected) exits 1. */
export const exitCodes = { completed: 0, usage: 2, failed: 3, limit: 4, request: 5, interrupted: 130 } as const;
type RunStatus = Exclude<keyof typeof exitCodes, "usage">;
type TurnStatus = Extract<Event, { type: "turn.completed" }>["status"];
type Escalation = Pick<Extract<Event, { type: "task.escalated" }>, "trigger" | "step" | "from" | "to" | "reason">;
const runStatus: Record<TurnStatus, RunStatus> = { success: "completed", error: "failed", interrupted: "interrupted", limit: "limit" };

/**
 * `--json`'s one object. `turnId` is the turn the run sent; the run follows its task through the turns Verdandi sends
 * after it (`escalations`, each step's trigger and route before and after), so `status`, `route`, `cost` (metered and subscription
 * kept apart) and `reply` cover them all.
 */
export type RunResult = {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly taskId: TaskId | null;
  readonly status: RunStatus;
  readonly route: Route;
  readonly cost: SpendSplit;
  readonly reply: string;
  readonly escalations: readonly Escalation[];
  readonly error?: string;
};

type Options = {
  readonly home: string;
  readonly text: string;
  readonly mode: InteractionMode;
  readonly route: Route | "auto" | undefined;
  readonly threadId: ThreadId | undefined;
  readonly projectPath: string;
  readonly json: boolean;
  readonly deny: boolean;
};

const valueFlags = ["--home", "--project", "--thread", "--mode", "--route"];
const switches = ["--json", "--deny-requests"];

/** The task is every word that isn't a flag or a flag's value. Fails naming the flag or value at fault. */
const parse = (argv: readonly string[]): Options => {
  const unknown = argv.find((a) => a.startsWith("--") && !valueFlags.includes(a.split("=")[0] ?? "") && !switches.includes(a));
  if (unknown) throw new Error(`verdandi run has no ${unknown} flag. Quote a task that contains one: verdandi run "add a --verbose flag".`);
  const text = argv
    .filter((a, i) => !a.startsWith("--") && !valueFlags.includes(argv[i - 1] ?? ""))
    .join(" ")
    .trim();
  if (!text) throw new Error('verdandi run needs a task, e.g. verdandi run "fix the failing test".');
  const mode = flag(argv, "--mode") ?? "build";
  if (!Schema.is(InteractionMode)(mode)) throw new Error(`--mode takes ask, plan or build; not "${mode}".`);
  const route = flag(argv, "--route");
  const project = flag(argv, "--project");
  const threadId = flag(argv, "--thread") as ThreadId | undefined;
  if (threadId && project !== undefined) throw new Error("--thread continues a thread in its own folder, so leave out --project.");
  return {
    home: resolveHome(argv),
    text,
    mode,
    route: route === undefined ? undefined : parseBatchRoute(route),
    threadId,
    projectPath: resolve(expandHome(project ?? ".")),
    json: argv.includes("--json"),
    deny: argv.includes("--deny-requests"),
  };
};

/** What the agent stopped for, in a line, or with a plan the plan itself. */
const describeRequest = (r: PendingRequest) =>
  r.type === "approval.requested"
    ? `approval to use ${r.toolName} ${clip(JSON.stringify(r.input), 400)}`
    : r.type === "user-input.requested"
      ? `an answer to: ${r.questions.map((q) => `${q.question} (${q.options.map((o) => o.label).join(", ")})`).join(" ")}`
      : r.type === "skill.proposed"
        ? `approval to ${skillChangeTitle(r.change)}`
        : `approval of its plan:\n${r.plan}`;

const uuid = <T>() => crypto.randomUUID() as T;
type Signal = ThreadFeed | { readonly kind: "sigint" } | { readonly kind: "ended" };

/**
 * Sends the turn on a new thread or `--thread`, follows the thread's feed until its task stops, and says how it went.
 * After a turn of a routed task that set off an escalation trigger (a failed verifier, or the agent reporting it's
 * blocked) it waits for Verdandi's decision (DESIGN §8.7), which the decider records for every such turn, and follows
 * the turn it sends (`nextTurnId`) the same way.
 */
const runTurn = (server: ServerFile, o: Options) =>
  Effect.gen(function* () {
    const client = yield* connect(server);
    const dispatch = (command: ClientCommand) => client.CommandDispatch(command);
    const threadId = o.threadId ?? uuid<ThreadId>();
    if (!o.threadId) {
      const route = o.route !== "auto" && o.route ? { route: o.route } : {};
      yield* dispatch({ type: "thread.create", commandId: uuid<CommandId>(), threadId, projectPath: o.projectPath, ...route });
    }

    // The consumer only hands messages over; every RPC call happens in the loop below, outside it (ADR 0008).
    const signals = yield* Queue.unbounded<Signal>();
    const subscriptionId = crypto.randomUUID();
    const feed = yield* client.ThreadSubscribe({ threadId, subscriptionId }).pipe(
      Stream.runForEach((f) => Queue.offer(signals, f)),
      Effect.ensuring(Queue.offer(signals, { kind: "ended" })),
      Effect.forkChild,
    );
    const ended = Fiber.join(feed).pipe(
      Effect.andThen(
        Effect.fail(
          new Error(`The thread feed ended before the turn did. Check verdandid, then the thread: verdandi chat --thread ${threadId}`),
        ),
      ),
    );
    const first = yield* Queue.take(signals);
    if (first.kind !== "snapshot") return yield* ended;
    const thread = first.thread;
    // `--route` on a thread pins it from this turn on, or with `auto` hands it back to the router (as `verdandi chat` does).
    if (o.route === "auto" && thread.pinned) yield* dispatch({ type: "thread.route.unpin", commandId: uuid<CommandId>(), threadId });
    if (o.route && o.route !== "auto" && (!thread.pinned || describeRouteChange(thread.route, o.route) !== "")) {
      yield* dispatch({ type: "thread.route.set", commandId: uuid<CommandId>(), threadId, route: o.route });
    }

    const turnId = uuid<TurnId>();
    // The turn followed now: the run's own, then each one Verdandi sends to go on with the task.
    let current = turnId;
    const interrupt = () =>
      dispatch({ type: "turn.interrupt", commandId: uuid<CommandId>(), threadId, turnId: current }).pipe(
        Effect.catchTag("CommandRejected", () => Effect.void), // it ended first
      );
    // Ctrl+C interrupts the turn and waits for it to end; a second one quits at once.
    let interrupting = false;
    const onSigint = () => {
      if (interrupting) process.exit(exitCodes.interrupted);
      interrupting = true;
      Queue.offerUnsafe(signals, { kind: "sigint" });
    };
    process.on("SIGINT", onSigint);
    yield* Effect.addFinalizer(() => Effect.sync(() => process.off("SIGINT", onSigint)));
    yield* dispatch({ type: "turn.send", commandId: uuid<CommandId>(), threadId, turnId, text: o.text, mode: o.mode });

    let route = thread.route;
    let taskId = thread.task?.taskId ?? null;
    // Only a routed task escalates: neither the thread nor the task pinned (as the decider's `task.escalate` checks).
    let pinned = thread.pinned;
    let taskPinned = thread.task?.source === "pin";
    const usage: Usage[] = [];
    const reply: string[] = [];
    const escalations: Escalation[] = [];
    let verifier: VerifierRun | undefined;
    let blocked = false;
    let asked: PendingRequest | undefined;
    // Set once the followed turn has completed after a trigger, until Verdandi decides whether the task goes on.
    let awaiting: { readonly status: RunStatus; readonly error: string | undefined } | undefined;
    // Deltas stream the agent's text; a message that came without them (a harness that doesn't stream) prints whole.
    let streamed = false;
    let atLineStart = true;
    const write = (text: string) => {
      if (o.json || !text) return;
      process.stdout.write(text);
      atLineStart = text.endsWith("\n");
    };
    const finish = (status: RunStatus, error: string | undefined) =>
      Effect.gen(function* () {
        if (!atLineStart) write("\n");
        yield* client.Unsubscribe({ subscriptionId });
        yield* Fiber.join(feed);
        return {
          threadId,
          turnId,
          taskId,
          status,
          route,
          cost: spendSplit(usage),
          reply: reply.join("\n"),
          escalations,
          ...(error && { error }),
        } satisfies RunResult;
      });
    for (;;) {
      const s = yield* Queue.take(signals);
      if (s.kind === "ended") return yield* ended;
      if (s.kind === "sigint") yield* interrupt();
      if (s.kind === "delta" && s.turnId === current) {
        write(s.text);
        streamed = true;
      }
      if (s.kind !== "event") continue;
      const e = s.stored.event;
      // Only this run's turn can start a task here: another turn would have made ours `ThreadBusy`.
      if (e.type === "task.started") {
        taskId = e.taskId;
        route = e.route;
        taskPinned = e.decision?.source === "pin";
      }
      if (e.type === "task.rerouted" || e.type === "task.deescalated") route = e.to;
      if (e.type === "thread.route.changed") pinned = true;
      if (e.type === "thread.route.unpinned") pinned = false;
      if (e.type === "task.escalated" && e.turnId === current) {
        const { trigger, step, from, to, reason } = e;
        escalations.push({ trigger, step, from, ...(to && { to }), reason });
        // At `ask` the task stopped short of done, even when its last turn succeeded (an agent that reported it's blocked).
        if (!to || !e.nextTurnId) {
          const error = `${awaiting?.error ?? ""}\n${reason} Continue the thread with verdandi chat --thread ${threadId}.`.trimStart();
          return yield* finish(awaiting && awaiting.status !== "completed" ? awaiting.status : "failed", error);
        }
        if (!atLineStart) write("\n");
        if (!o.json) process.stderr.write(`[escalated to ${to.model} ${to.effort}: ${reason}]\n`);
        route = to;
        current = e.nextTurnId;
        verifier = undefined;
        blocked = false;
        awaiting = undefined;
        // A run that is stopping, for a Ctrl+C or a request, stops the turn Verdandi sent too.
        if (interrupting || asked) yield* interrupt();
        continue;
      }
      // No decision is coming once the task was pinned or ended, or another turn started, before Verdandi decided.
      // Otherwise one always is: the decider never rejects `task.escalate`, so only a failing database loses it.
      const preempted = !awaiting
        ? undefined
        : pinned || taskPinned
          ? "the task was pinned"
          : e.type === "thread.archived"
            ? "the thread was archived"
            : e.type === "thread.reverted"
              ? "the thread was reverted"
              : e.type === "turn.started" && e.turnId !== current
                ? "another turn started"
                : undefined;
      if (awaiting && preempted) {
        const why = `The task stopped here: ${preempted} before Verdandi decided whether to escalate it.`;
        return yield* finish(awaiting.status, `${awaiting.error ?? ""}\n${why}`.trimStart());
      }
      if (!("turnId" in e) || e.turnId !== current) continue;
      if (e.type === "turn.item.added" && e.item.kind === "assistant.message" && !e.item.parentToolUseId) {
        reply.push(e.item.text);
        if (!streamed) write(e.item.text);
        if (!atLineStart) write("\n");
        streamed = false;
      }
      if (e.type === "turn.usage.recorded") usage.push(e);
      if (e.type === "task.blocked") blocked = true;
      if (e.type === "verifier.ran") verifier = e;
      if (
        e.type === "approval.requested" ||
        e.type === "user-input.requested" ||
        e.type === "plan.requested" ||
        e.type === "skill.proposed"
      ) {
        if (o.deny) {
          process.stderr.write(`[denied ${describeRequest(e)}]\n`);
          const resolution = { decision: "deny" } as const;
          yield* dispatch({ type: "approval.respond", commandId: uuid<CommandId>(), threadId, requestId: e.requestId, resolution }).pipe(
            Effect.catchTag("CommandRejected", () => Effect.void), // the turn ended first
          );
        } else if (!asked) {
          asked = e;
          yield* interrupt();
        }
      }
      if (e.type !== "turn.completed") continue;
      const verifierFailed = e.status === "success" && verifier?.passed === false;
      const status: RunStatus = asked && e.status === "interrupted" ? "request" : verifierFailed ? "failed" : runStatus[e.status];
      const tail = verifier?.output.trimEnd().split(/\r?\n/).slice(-10).join("\n");
      const error =
        status === "request" && asked
          ? `The agent stopped for ${describeRequest(asked)}\nverdandi run never answers for you, so it interrupted the turn. Continue the thread with verdandi chat --thread ${threadId} to answer what it asks, or rerun with --deny-requests to deny it and let the agent go on.`
          : verifierFailed && verifier
            ? `The verifier ${verifier.command} failed${verifier.exitCode === null ? "" : ` (exit ${verifier.exitCode})`}:\n${tail}`
            : e.error;
      // The reactor asks to escalate after a failed verifier, or else a blocked report, whatever the turn's status.
      // ponytail: a repeated tool error (`escalation.repeatedErrors`) isn't awaited, since nothing on the turn says one
      // fired, so run ends here and the escalation's turn goes on in the thread. Upgrade: record the trigger on the turn
      // before it completes, like `task.blocked`, and wait on it here.
      if ((verifierFailed || blocked) && !pinned && !taskPinned) awaiting = { status, error };
      else return yield* finish(status, error);
    }
  });

/**
 * `verdandi run "<task>"`: sends one turn without a person at the keyboard, prints the agent's text as it streams (or
 * one JSON object with `--json`), follows the turns Verdandi sends to escalate its task, and exits with the code for how
 * the task stopped (`exitCodes`). Never approves anything.
 */
export const run = async (argv: readonly string[]) => {
  let options: Options;
  try {
    options = parse(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = exitCodes.usage;
    return;
  }
  const result = await Effect.runPromise(Effect.scoped(runTurn(readServerFile(options.home), options)));
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.error) process.stderr.write(`${result.error}\n`);
  if (!options.json) {
    const { harness, model, effort } = result.route;
    const cost = describeCost(result.cost);
    process.stderr.write(
      `[${result.status} on ${model} ${effort} via ${harness}${cost ? ` · ${cost}` : ""} · thread ${result.threadId}]\n`,
    );
  }
  process.exitCode = exitCodes[result.status];
};
