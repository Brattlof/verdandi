import { createHash } from "node:crypto";
import {
  type CapPeriod,
  type CapScope,
  type Command,
  CommandRejected,
  capName,
  capPeriodNow,
  capReached,
  type DecisionAnswer,
  type DecisionQuestion,
  defaultRoute,
  type Event,
  formatUsd,
  type HarnessEvent,
  type ProjectId,
  type Resolution,
  type RouteDecision,
  type TaskId,
  type ThreadId,
  type TurnId,
} from "@verdandi/contracts";
import { Result } from "effect";
import { decideExecuteRoute, decideRoute, type RoutingContext, type RoutingThread, routeInputs, routeOf } from "../routing/routing.ts";
import type { SpendState } from "./spend.ts";

export type PendingRequest = {
  readonly requestId: string;
  readonly turnId: TurnId;
  readonly kind: "approval" | "user-input" | "plan";
  /** A plan's route for the build, when approving it moves the task (`plan.requested`'s `execute`). */
  readonly execute?: RouteDecision;
};

/** What the decider needs to know about the command's thread; `undefined` when it doesn't exist. */
export type DeciderState = {
  readonly thread:
    | (RoutingThread & {
        readonly projectId: ProjectId;
        readonly projectPath: string;
        readonly runningTurnId: string | null;
        /** Put away by the user: it takes no turns until unarchived. */
        readonly archived: boolean;
        /** The task the next turn continues; null before the first turn and after a route change. */
        readonly taskId: TaskId | null;
        /** How many turns the thread has had. */
        readonly turns: number;
        /** Why that task runs on its route, and whether it started in plan mode. Null without a task, or one from before routing. */
        readonly taskDecision: RouteDecision | null;
        readonly taskPlanned: boolean;
        readonly pendingRequests: readonly PendingRequest[];
      })
    | undefined;
  /**
   * Loaded only when a `turn.send` starts a task, or a routed task's plan is proposed. Without it a task keeps
   * the thread's route, unexplained, and an approved plan's build stays on it.
   */
  readonly routing?: RoutingContext;
  /** The decision layer's answers about a `turn.send`'s text, asked by the engine: recorded, and routing reads them. */
  readonly decisions?: { readonly questions: readonly DecisionQuestion[]; readonly answers: readonly DecisionAnswer[] };
  /** The spend caps over the thread, loaded for `turn.send` and `spend.cap.raise`. Without it nothing is capped. */
  readonly spend?: SpendState;
};

type Decision = Result.Result<Event[], CommandRejected>;

/** Same folder, same project: drive letter case and slash direction don't matter. */
export const projectIdFor = (path: string): ProjectId => {
  const normalized = path.replaceAll("\\", "/").replace(/^([a-zA-Z]):/, (_, d: string) => `${d.toLowerCase()}:`);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32) as ProjectId;
};

const reject = (reason: CommandRejected["reason"], message: string): Decision => Result.fail(new CommandRejected({ reason, message }));
const accept = (...events: Event[]): Decision => Result.succeed(events);

/** A turn that ends can no longer use an answer, so its open requests are denied, with the reason recorded. */
const denyPending = (state: DeciderState, threadId: ThreadId, turnId: TurnId, reason: string): Event[] =>
  (state.thread?.pendingRequests ?? [])
    .filter((r) => r.turnId === turnId)
    .map((r) => ({ type: "approval.resolved", v: 1, threadId, turnId, requestId: r.requestId, resolution: { decision: "deny" }, reason }));

const fits: Record<PendingRequest["kind"], readonly Resolution["decision"][]> = {
  approval: ["allow", "deny"],
  "user-input": ["answer", "deny"],
  plan: ["allow", "deny"],
};

const configKey: Record<CapScope, Record<CapPeriod, string>> = {
  profile: { day: "daily", month: "monthly" },
  project: { day: "daily under projects", month: "monthly under projects" },
};

/** Why a turn can't start: the caps file is broken, or a cap over the thread is reached. */
const capped = (spend: SpendState | undefined): Decision | undefined => {
  if (!spend) return undefined;
  if (Result.isFailure(spend)) return reject("InvalidSpendCaps", spend.failure);
  const cap = spend.success.caps.find(capReached);
  if (!cap) return undefined;
  const now = capPeriodNow(cap.period);
  return reject(
    "SpendCapReached",
    // ponytail: blocks every turn while a cap is reached, even one that would run inside a subscription window.
    // Upgrade: block only turns whose target spends metered dollars, once the quota window's state is trusted here (§8.3).
    `The ${capName(cap)} of metered spend is reached: ${formatUsd(cap.spentUsd)} of ${formatUsd(cap.limitUsd)} spent ${now}. ` +
      `Raise it for the rest of ${now} with Raise in the web UI or \`verdandi chat --raise-cap\`, or change ${configKey[cap.scope][cap.period]} in ${spend.success.file}.`,
  );
};

type Handler<T extends Command["type"]> = (state: DeciderState, command: Extract<Command, { type: T }>) => Decision;

const fromHarness = (state: DeciderState, threadId: ThreadId, turnId: TurnId, event: HarnessEvent): Decision => {
  switch (event.type) {
    case "session.started":
      return event.sessionId === state.thread?.sessionId ? accept() : accept({ ...event, type: "harness.session.bound", v: 1, threadId });
    case "text.delta":
      return accept(); // broadcast by the reactor, never persisted
    case "item":
      return accept({ type: "turn.item.added", v: 1, threadId, turnId, item: event.item });
    case "usage": {
      const { type: _, ...usage } = event;
      return accept({ type: "turn.usage.recorded", v: 1, threadId, turnId, ...usage });
    }
    case "quota":
      // A running turn's thread exists, and its harness can't change until the turn ends.
      return state.thread
        ? accept({ type: "harness.quota.reported", v: 1, threadId, turnId, harness: state.thread.route.harness, quota: event.quota })
        : accept();
    case "approval.requested":
      return accept({ ...event, v: 1, threadId, turnId });
    case "user-input.requested":
      return accept({ ...event, v: 1, threadId, turnId });
    case "plan.requested": {
      // A routed task started in plan mode moves its build to the class's own route when the plan is approved.
      const { thread, routing } = state;
      const execute =
        thread?.taskPlanned && thread.taskDecision && routing
          ? decideExecuteRoute(thread, routing, thread.taskDecision, event.plan)
          : undefined;
      return accept({ ...event, v: 1, threadId, turnId, ...(execute && { execute }) });
    }
    case "turn.finished":
      return accept(...denyPending(state, threadId, turnId, "The turn ended before this was answered."), {
        type: "turn.completed",
        v: 1,
        threadId,
        turnId,
        status: event.status,
        ...(event.error === undefined ? {} : { error: event.error }),
      });
  }
};

const handlers: { [T in Command["type"]]: Handler<T> } = {
  "thread.create": (state, c) =>
    state.thread
      ? reject("ThreadExists", `Thread ${c.threadId} already exists.`)
      : accept({
          type: "thread.created",
          v: 1,
          threadId: c.threadId,
          projectId: projectIdFor(c.projectPath),
          projectPath: c.projectPath,
          route: c.route ?? defaultRoute,
          pinned: c.route !== undefined,
        }),
  "turn.send": (state, c) => {
    if (!state.thread) return reject("ThreadNotFound", `Thread ${c.threadId} does not exist. Create it first.`);
    if (state.thread.runningTurnId) return reject("ThreadBusy", "A turn is already running in this thread. Wait for it to finish.");
    if (state.thread.archived) {
      return reject(
        "ThreadArchived",
        `Thread ${c.threadId} is archived. Unarchive it to send a turn: Unarchive in the web UI, or \`verdandi chat --unarchive ${c.threadId}\`.`,
      );
    }
    const stop = capped(state.spend);
    if (stop) return stop;
    const attachments = c.attachments?.length ? { attachments: c.attachments } : {};
    const turn: Event = { type: "turn.started", v: 2, threadId: c.threadId, turnId: c.turnId, text: c.text, mode: c.mode, ...attachments };
    // First: the reactor starts the turn on turn.started, and a later event of this commit could reach feeds after the turn ends.
    const recorded: Event[] = state.decisions
      ? [{ type: "decision.recorded", v: 1, threadId: c.threadId, turnId: c.turnId, ...state.decisions }]
      : [];
    if (state.thread.taskId) return accept(...recorded, turn);
    const task = { type: "task.started", v: 2, threadId: c.threadId, taskId: c.turnId as string as TaskId } as const;
    if (!state.routing) return accept(...recorded, { ...task, route: state.thread.route }, turn);
    const images = c.attachments?.filter((a) => a.kind === "image").length ?? 0;
    const decided = decideRoute(state.thread, state.routing, c.text, c.mode, state.decisions?.answers ?? [], images);
    if (Result.isFailure(decided)) return reject(decided.failure.reason, decided.failure.message);
    const inputs = routeInputs(state.thread, state.routing);
    return accept(...recorded, { ...task, route: routeOf(decided.success), decision: decided.success, inputs }, turn);
  },
  "thread.route.set": (state, c) => {
    if (!state.thread) return reject("ThreadNotFound", `Thread ${c.threadId} does not exist. Create it first.`);
    const from = state.thread.route;
    // Picking the route the router chose still pins it; picking the pinned route again changes nothing.
    const same = from.harness === c.route.harness && from.model === c.route.model && from.effort === c.route.effort;
    if (same && state.thread.pinned) return accept();
    // A model or effort change waits for the next turn; a harness change would split the running turn's session.
    if (from.harness !== c.route.harness && state.thread.runningTurnId) {
      return reject("ThreadBusy", "A turn is running in this thread. Change the harness when it finishes.");
    }
    // A harness session keeps the subagents it started with, whatever the client sent; a new harness starts without.
    const { subagents: _, ...picked } = c.route;
    const to = from.harness === picked.harness && from.subagents ? { ...picked, subagents: from.subagents } : picked;
    return accept({ type: "thread.route.changed", v: 1, threadId: c.threadId, from, to, by: "user" });
  },
  "thread.budget.set": (state, c) => {
    if (!state.thread) return reject("ThreadNotFound", `Thread ${c.threadId} does not exist. Create it first.`);
    return state.thread.budgetMode === c.mode
      ? accept()
      : accept({ type: "thread.budget.changed", v: 1, threadId: c.threadId, mode: c.mode });
  },
  "routing.memory.clear": (state, c) =>
    state.thread
      ? accept({ type: "routing.memory.cleared", v: 1, threadId: c.threadId, projectId: state.thread.projectId })
      : reject("ThreadNotFound", `Thread ${c.threadId} does not exist. Create it first.`),
  "thread.archive": (state, c) => {
    if (!state.thread) return reject("ThreadNotFound", `Thread ${c.threadId} does not exist.`);
    if (state.thread.runningTurnId) {
      return reject(
        "ThreadBusy",
        "A turn is running in this thread. Interrupt it first (Stop in the web UI, Ctrl+C in `verdandi chat`), then archive it.",
      );
    }
    return state.thread.archived ? accept() : accept({ type: "thread.archived", v: 1, threadId: c.threadId });
  },
  "thread.unarchive": (state, c) => {
    if (!state.thread) return reject("ThreadNotFound", `Thread ${c.threadId} does not exist.`);
    return state.thread.archived ? accept({ type: "thread.unarchived", v: 1, threadId: c.threadId }) : accept();
  },
  "thread.route.unpin": (state, c) => {
    if (!state.thread) return reject("ThreadNotFound", `Thread ${c.threadId} does not exist. Create it first.`);
    return state.thread.pinned ? accept({ type: "thread.route.unpinned", v: 1, threadId: c.threadId }) : accept();
  },
  "spend.cap.raise": (state, c) => {
    if (!state.thread) return reject("ThreadNotFound", `Thread ${c.threadId} does not exist. Create it first.`);
    if (state.spend && Result.isFailure(state.spend)) return reject("InvalidSpendCaps", state.spend.failure);
    const cap = state.spend?.success.caps.find((k) => k.scope === c.scope && k.period === c.period);
    if (!cap) {
      const where = state.spend ? ` Set ${configKey[c.scope][c.period]} in ${state.spend.success.file} to add one.` : "";
      return reject("SpendCapNotSet", `The ${c.scope} has no ${c.period === "day" ? "daily" : "monthly"} spend cap to raise.${where}`);
    }
    return accept({
      type: "spend.cap.raised",
      v: 1,
      threadId: c.threadId,
      scope: c.scope,
      ...(c.scope === "project" ? { projectId: projectIdFor(state.thread.projectPath) } : {}),
      period: c.period,
      periodKey: cap.periodKey,
      fromUsd: cap.limitUsd,
      toUsd: cap.limitUsd + cap.baseUsd,
    });
  },
  "approval.respond": (state, c) => {
    if (!state.thread) return reject("ThreadNotFound", `Thread ${c.threadId} does not exist.`);
    const request = state.thread.pendingRequests.find((r) => r.requestId === c.requestId);
    if (!request)
      return reject(
        "RequestNotPending",
        `Request ${c.requestId} is not waiting for an answer: it was answered already, or its turn ended.`,
      );
    if (!fits[request.kind].includes(c.resolution.decision)) {
      return reject(
        "InvalidResolution",
        `A ${request.kind} request takes ${fits[request.kind].join(" or ")}, not ${c.resolution.decision}.`,
      );
    }
    const resolved: Event = {
      type: "approval.resolved",
      v: 1,
      threadId: c.threadId,
      turnId: request.turnId,
      requestId: c.requestId,
      resolution: c.resolution,
    };
    // The build moves only if the thread is still routed and on the task the plan was made for.
    const { execute } = request;
    const { pinned, taskId, route } = state.thread;
    if (c.resolution.decision !== "allow" || !execute || pinned || !taskId) return accept(resolved);
    const to = routeOf(execute);
    return accept(
      { type: "task.rerouted", v: 1, threadId: c.threadId, taskId, turnId: request.turnId, from: route, to, decision: execute },
      resolved,
    );
  },
  "turn.steer": (state, c) => {
    if (!state.thread) return reject("ThreadNotFound", `Thread ${c.threadId} does not exist. Create it first.`);
    if (state.thread.runningTurnId !== c.turnId) {
      return reject("TurnNotRunning", `Turn ${c.turnId} is not running, so it can't be steered. Send the message as a new turn instead.`);
    }
    return accept({ type: "turn.steered", v: 1, threadId: c.threadId, turnId: c.turnId, text: c.text });
  },
  "turn.interrupt": (state, c) => {
    if (!state.thread) return reject("ThreadNotFound", `Thread ${c.threadId} does not exist. Create it first.`);
    if (state.thread.runningTurnId !== c.turnId)
      return reject("TurnNotRunning", `Turn ${c.turnId} is not running, so there is nothing to interrupt.`);
    return accept(...denyPending(state, c.threadId, c.turnId, "The user interrupted the turn."), {
      type: "turn.completed",
      v: 1,
      threadId: c.threadId,
      turnId: c.turnId,
      status: "interrupted",
    });
  },
  // An interrupted turn's harness can still report while it winds down; only its session binding still counts.
  "harness.report": (state, c) =>
    c.event.type === "session.started" || state.thread?.runningTurnId === c.turnId
      ? fromHarness(state, c.threadId, c.turnId, c.event)
      : accept(),
  "turn.recover": (state, c) =>
    state.thread?.runningTurnId === c.turnId
      ? accept(...denyPending(state, c.threadId, c.turnId, "verdandid stopped while this was waiting for an answer."), {
          type: "turn.completed",
          v: 1,
          threadId: c.threadId,
          turnId: c.turnId,
          status: "interrupted",
          error: "verdandid stopped during this turn",
        })
      : accept(),
};

/** Pure: turns a command into the events it causes, or rejects it. */
export const decide = (state: DeciderState, command: Command): Decision =>
  (handlers[command.type] as Handler<Command["type"]>)(state, command);
