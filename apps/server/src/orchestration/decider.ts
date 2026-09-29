import { createHash } from "node:crypto";
import {
  type Command,
  CommandRejected,
  type Event,
  type HarnessEvent,
  type ProjectId,
  type ThreadId,
  type TurnId,
} from "@verdandi/contracts";
import { Result } from "effect";

/** What the decider needs to know about the command's thread; `undefined` when it doesn't exist. */
export type DeciderState = {
  readonly thread: { readonly projectPath: string; readonly runningTurnId: string | null; readonly sessionId: string | null } | undefined;
};

type Decision = Result.Result<Event[], CommandRejected>;

/** Same folder, same project: drive letter case and slash direction don't matter. */
export const projectIdFor = (path: string): ProjectId => {
  const normalized = path.replaceAll("\\", "/").replace(/^([a-zA-Z]):/, (_, d: string) => `${d.toLowerCase()}:`);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32) as ProjectId;
};

const reject = (reason: CommandRejected["reason"], message: string): Decision => Result.fail(new CommandRejected({ reason, message }));
const accept = (...events: Event[]): Decision => Result.succeed(events);

type Handler<T extends Command["type"]> = (state: DeciderState, command: Extract<Command, { type: T }>) => Decision;

const fromHarness = (state: DeciderState, threadId: ThreadId, turnId: TurnId, event: HarnessEvent): Decision => {
  switch (event.type) {
    case "session.started":
      return event.sessionId === state.thread?.sessionId
        ? accept()
        : accept({ type: "harness.session.bound", v: 1, threadId, sessionId: event.sessionId, harnessVersion: event.harnessVersion });
    case "text.delta":
      return accept(); // broadcast by the reactor, never persisted
    case "item":
      return accept({ type: "turn.item.added", v: 1, threadId, turnId, item: event.item });
    case "usage": {
      const { type: _, ...usage } = event;
      return accept({ type: "turn.usage.recorded", v: 1, threadId, turnId, ...usage });
    }
    case "turn.finished":
      return accept({
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
    return accept({ type: "turn.started", v: 1, threadId: c.threadId, turnId: c.turnId, text: c.text });
  },
  "harness.report": (state, c) => fromHarness(state, c.threadId, c.turnId, c.event),
  "turn.recover": (state, c) =>
    state.thread?.runningTurnId === c.turnId
      ? accept({
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
