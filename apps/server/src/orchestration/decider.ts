import { createHash } from "node:crypto";
import {
  type Command,
  CommandRejected,
  type Event,
  type HarnessEvent,
  type ProjectId,
  type Resolution,
  type Route,
  type ThreadId,
  type TurnId,
} from "@verdandi/contracts";
import { Result } from "effect";

export type PendingRequest = { readonly requestId: string; readonly turnId: TurnId; readonly kind: "approval" | "user-input" | "plan" };

/** What the decider needs to know about the command's thread; `undefined` when it doesn't exist. */
export type DeciderState = {
  readonly thread:
    | {
        readonly projectPath: string;
        readonly route: Route;
        readonly runningTurnId: string | null;
        readonly sessionId: string | null;
        readonly pendingRequests: readonly PendingRequest[];
      }
    | undefined;
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
    case "plan.requested":
      return accept({ ...event, v: 1, threadId, turnId });
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
          route: c.route,
        }),
  "turn.send": (state, c) => {
    if (!state.thread) return reject("ThreadNotFound", `Thread ${c.threadId} does not exist. Create it first.`);
    if (state.thread.runningTurnId) return reject("ThreadBusy", "A turn is already running in this thread. Wait for it to finish.");
    return accept({ type: "turn.started", v: 1, threadId: c.threadId, turnId: c.turnId, text: c.text, mode: c.mode });
  },
  "thread.route.set": (state, c) => {
    if (!state.thread) return reject("ThreadNotFound", `Thread ${c.threadId} does not exist. Create it first.`);
    const from = state.thread.route;
    if (from.harness === c.route.harness && from.model === c.route.model && from.effort === c.route.effort) return accept();
    // A model or effort change waits for the next turn; a harness change would split the running turn's session.
    if (from.harness !== c.route.harness && state.thread.runningTurnId) {
      return reject("ThreadBusy", "A turn is running in this thread. Change the harness when it finishes.");
    }
    return accept({ type: "thread.route.changed", v: 1, threadId: c.threadId, from, to: c.route, by: "user" });
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
    return accept({
      type: "approval.resolved",
      v: 1,
      threadId: c.threadId,
      turnId: request.turnId,
      requestId: c.requestId,
      resolution: c.resolution,
    });
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
