import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  type CanUseTool,
  type PermissionMode,
  type PermissionResult,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type HarnessAdapter,
  HarnessError,
  type HarnessEvent,
  type HarnessRunInput,
  type InteractionMode,
  Question,
  type Resolution,
  type Route,
  type ThreadId,
} from "@verdandi/contracts";
import { Effect, Exit, Option, Schema, Stream } from "effect";
import { initialContext, type NormalizeContext, normalize } from "./normalize.ts";

export type QueryFn = typeof query;

/** Turn ids are UUIDs by contract, so they can be the prompt uuid a later fork points at (ADR 0004). */
type UUID = NonNullable<SDKUserMessage["uuid"]>;

/** The user's installed Claude Code CLI (ADR 0001), or undefined when it isn't on PATH. */
export const findClaude = () => Bun.which("claude") ?? undefined;

/** One long-lived Claude Code process per thread, fed through a single prompt stream. */
type Session = {
  readonly query: Query;
  readonly push: (message: SDKUserMessage) => void;
  readonly next: () => Promise<IteratorResult<SDKMessage>>;
  readonly close: () => void;
  /** Requests `canUseTool` raised that the running turn hasn't reported yet. */
  readonly raised: HarnessEvent[];
  /** Resolves when `canUseTool` raises a request. */
  readonly nextRaise: () => Promise<void>;
  /** `canUseTool` calls waiting for an answer, by request id. */
  readonly waiting: Map<string, (resolution: Resolution) => void>;
  context: NormalizeContext;
  /** False once the running turn's last result is read: a steer pushed after that would start a turn nobody reads. */
  live: boolean;
  /** Uuids of this turn's steers that no result has reported consuming yet. */
  readonly unanswered: Set<string>;
  /** The route the process is running on now. */
  route: Route;
  /** A `reroute` in flight: answers wait for it, so the agent's next step runs on the new route (ADR 0013). */
  rerouting: Promise<void>;
  /** Whether Claude Code is in its read-only plan mode, which ask and plan turns run in. */
  planning: boolean;
  /** The permission mode Claude Code last reported outside plan mode: the user's own default, which build restores. */
  buildMode: PermissionMode | undefined;
  /** Claude Code's session id, once its init message arrives. */
  sessionId: string | undefined;
  /** The session's transcript file, as Claude Code's hooks report it. */
  transcriptPath: string | undefined;
  /** Whether the CLI reports `session_state_changed`. Older ones don't, and their turns end at the last result. */
  reportsState: boolean;
};

const decodeQuestions = Schema.decodeUnknownOption(Schema.Struct({ questions: Schema.Array(Question) }));
/** `ExitPlanMode` carries the plan text and where Claude Code saved it (ADR 0003). */
const decodePlan = Schema.decodeUnknownOption(Schema.Struct({ plan: Schema.String, planFilePath: Schema.optionalKey(Schema.String) }));

/** The request `canUseTool` raises for a tool call. */
const requestFor = (requestId: string, toolName: string, input: Record<string, unknown>): HarnessEvent => {
  if (toolName === "AskUserQuestion") {
    const asked = decodeQuestions(input);
    if (Option.isSome(asked)) return { type: "user-input.requested", requestId, questions: asked.value.questions };
  }
  if (toolName === "ExitPlanMode") {
    const proposed = decodePlan(input);
    if (Option.isSome(proposed)) {
      const { plan, planFilePath } = proposed.value;
      return { type: "plan.requested", requestId, plan, ...(planFilePath === undefined ? {} : { filePath: planFilePath }) };
    }
  }
  return { type: "approval.requested", requestId, toolName, input };
};

/** The SDK answer for a resolution. Deny messages stay neutral: they reach the model as tool output (ADR 0003). */
const toPermission = (input: Record<string, unknown>, resolution: Resolution): PermissionResult => {
  switch (resolution.decision) {
    case "allow":
      return { behavior: "allow", updatedInput: input };
    case "answer":
      return { behavior: "allow", updatedInput: { ...input, answers: resolution.answers } };
    case "deny":
      return { behavior: "deny", message: "The user denied this." };
  }
};

const openSession = (queryFn: QueryFn, claudePath: string, input: HarnessRunInput): Session => {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const prompt: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        const next = queue.shift();
        if (next) yield next;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
  const raised: HarnessEvent[] = [];
  const waiting = new Map<string, (resolution: Resolution) => void>();
  let onRaise: (() => void) | undefined;
  const raise = (event: HarnessEvent) => {
    raised.push(event);
    onRaise?.();
  };

  // Every tool the user's own settings don't allow lands here; AskUserQuestion becomes a user-input
  // request and ExitPlanMode a plan request.
  const canUseTool: CanUseTool = (toolName, toolInput, { signal }) =>
    new Promise((resolve) => {
      const requestId = randomUUID();
      const answer = (resolution: Resolution) => {
        if (!waiting.delete(requestId)) return;
        void session.rerouting.then(() => {
          resolve(toPermission(toolInput, resolution));
          // Allowing ExitPlanMode makes Claude Code leave plan mode for the mode it was in before.
          if (toolName === "ExitPlanMode" && resolution.decision === "allow") session.planning = false;
          if (resolution.decision === "deny" && resolution.feedback) say(session, resolution.feedback, "next");
        });
      };
      waiting.set(requestId, answer);
      signal.addEventListener("abort", () => answer({ decision: "deny" }), { once: true });
      raise(requestFor(requestId, toolName, toolInput));
    });

  const q = queryFn({
    prompt,
    options: {
      pathToClaudeCodeExecutable: claudePath,
      cwd: input.cwd,
      model: input.route.model,
      effort: input.route.effort,
      ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
      ...(input.mode === "build" ? {} : { permissionMode: "plan" as const }),
      includePartialMessages: true,
      // Subagents' text too, not only their tool calls, so their steps reach the trajectory whole.
      forwardSubagentText: true,
      // Fires before the init message on every prompt; SessionStart never reaches SDK callbacks.
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              async (hook) => {
                session.transcriptPath = hook.transcript_path;
                return {};
              },
            ],
          },
        ],
      },
      // `idle` marks the real end of a turn: after the result, background subagents can still run and be answered (ADR 0011).
      env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" },
      // Connectors attach nondeterministically and would change the tool list between turns (ADR 0001).
      settings: { disableClaudeAiConnectors: true },
      canUseTool,
    },
  });
  // One iterator for the session's lifetime: leaving a for-await early would close the CLI (ADR 0003).
  const iterator = q[Symbol.asyncIterator]();
  const session: Session = {
    query: q,
    push: (message) => {
      queue.push(message);
      wake?.();
    },
    next: () => iterator.next(),
    close: () => {
      closed = true;
      wake?.();
    },
    raised,
    nextRaise: () => (raised.length > 0 ? Promise.resolve() : new Promise((resolve) => (onRaise = resolve))),
    waiting,
    context: initialContext(),
    live: false,
    unanswered: new Set(),
    route: input.route,
    rerouting: Promise.resolve(),
    planning: input.mode !== "build",
    buildMode: undefined,
    sessionId: undefined,
    transcriptPath: undefined,
    reportsState: false,
  };
  return session;
};

/** Moves a live session onto the turn's route, between turns (ADR 0002). Each change breaks the message cache once. */
const applyRoute = async (session: Session, route: Route) => {
  if (session.route.model !== route.model) await session.query.setModel(route.model);
  if (session.route.effort !== route.effort) await session.query.applyFlagSettings({ effortLevel: route.effort });
  session.route = route;
};

/** Moves a live session into the turn's mode, between turns. Ask and plan both run in Claude Code's read-only plan mode. */
const applyMode = async (session: Session, mode: InteractionMode) => {
  const planning = mode !== "build";
  if (session.planning === planning) return;
  await session.query.setPermissionMode(planning ? "plan" : (session.buildMode ?? "default"));
  session.planning = planning;
};

/**
 * A user message for the running turn, which stays open until the agent has answered it. Steers go in
 * without `priority`, so they land at the next tool boundary; a deny's feedback goes in as `next` (ADR 0003).
 */
const say = (session: Session, text: string, priority?: "next") => {
  if (!session.live) return;
  const uuid = randomUUID();
  session.unanswered.add(uuid);
  session.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid, ...(priority && { priority }) });
};

/**
 * Whether Claude Code has more of this turn to send after a result. A steer that missed the last
 * tool boundary runs as a follow-up turn with its own result, which belongs to this Verdandi turn.
 */
const continues = (session: Session, msg: SDKMessage) => {
  if (msg.type !== "result" || msg.subtype !== "success" || msg.is_error) return false;
  for (const uuid of msg.user_message_uuids ?? []) session.unanswered.delete(uuid);
  // Older CLIs don't list consumed uuids; then only the queue count tells.
  return (msg.queued_turn_count ?? 0) > 0 || (msg.user_message_uuids !== undefined && session.unanswered.size > 0);
};

/** How long Claude Code gets to record an interrupted turn before its process is closed anyway. */
const stopGrace = "5 seconds";

export const makeClaudeCodeAdapter = (options: { readonly claudePath: string; readonly query?: QueryFn }): HarnessAdapter => {
  const sessions = new Map<ThreadId, Session>();
  const end = (threadId: ThreadId) => {
    sessions.get(threadId)?.close();
    sessions.delete(threadId);
  };

  /**
   * Stops the running turn. Claude Code gets to finish it (an error result, spike 003) so the session
   * records the stop; then the process closes, and the thread's next turn resumes the session in a fresh one.
   */
  const stop = (threadId: ThreadId, session: Session, events: AsyncGenerator<HarnessEvent>) =>
    Effect.tryPromise(async () => {
      await session.query.interrupt();
      for await (const _ of events);
    }).pipe(
      // ponytail: a fixed grace for a wedged CLI. Upgrade: make it configurable if slow machines hit it.
      Effect.timeoutOption(stopGrace),
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          if (sessions.get(threadId) === session) sessions.delete(threadId);
          session.close();
          session.query.close();
        }),
      ),
    );

  /** Reads the turn `run` opened until Claude Code goes idle, or on CLIs that don't report state, until its last result. */
  async function* turn(session: Session, input: HarnessRunInput): AsyncGenerator<HarnessEvent> {
    // Read lazily: a read left pending when the turn finishes would swallow the next turn's first message.
    let pending: Promise<IteratorResult<SDKMessage>> | undefined;
    /** A success held until `idle`: background subagents report after it, and Claude Code answers them in a result of its own. */
    let held: HarnessEvent | undefined;
    while (true) {
      pending ??= session.next();
      // While canUseTool waits for an answer the SDK sends nothing, so requests are raced against the next message.
      const step = await Promise.race([pending, session.nextRaise().then(() => undefined)]);
      yield* session.raised.splice(0);
      if (step === undefined) continue;
      pending = undefined;
      if (step.done) {
        sessions.delete(input.threadId);
        throw new HarnessError({
          message: "Claude Code exited before finishing the turn. Run `claude` in a terminal to check it still works.",
        });
      }
      const msg = step.value;
      if (msg.type === "system" && msg.subtype === "session_state_changed") {
        session.reportsState = true;
        // An interrupt while only background work runs goes idle with no result of its own; the turn has already ended as interrupted then.
        if (msg.state === "idle" && held) {
          session.live = false;
          yield held;
          return;
        }
        continue;
      }
      if (msg.type === "system" && msg.subtype === "init" && msg.permissionMode !== "plan") session.buildMode = msg.permissionMode;
      const normalized = normalize(msg, session.context);
      session.context = normalized.context;
      const events = normalized.events.map((e): HarnessEvent => {
        if (e.type !== "session.started") return e;
        session.sessionId = e.sessionId;
        return session.transcriptPath ? { ...e, transcriptPath: session.transcriptPath } : e;
      });
      if (continues(session, msg)) {
        yield* events.filter((e) => e.type !== "turn.finished");
        continue;
      }
      const finished = events.find((e) => e.type === "turn.finished");
      if (finished?.status === "success" && session.reportsState) {
        held = finished;
        yield* events.filter((e) => e !== finished);
        continue;
      }
      if (finished) session.live = false;
      yield* events;
      if (finished) {
        // After an error result the SDK throws on the next read (spike 005), so start a fresh process next turn.
        if (finished.status === "error") end(input.threadId);
        return;
      }
    }
  }

  return {
    id: "claude-code",
    run: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (!existsSync(input.cwd)) {
            return yield* new HarnessError({
              message: `Project folder not found: ${input.cwd}. Check that the path exists and is reachable.`,
            });
          }
          // A live session is only reused while it is the thread's session; a harness switch unbinds it.
          const live = sessions.get(input.threadId);
          if (live && live.sessionId !== input.resumeSessionId) end(input.threadId);
          const session = sessions.get(input.threadId) ?? openSession(options.query ?? query, options.claudePath, input);
          sessions.set(input.threadId, session);
          yield* Effect.tryPromise({
            try: async () => {
              await applyRoute(session, input.route);
              await applyMode(session, input.mode);
            },
            catch: (error) => {
              end(input.threadId);
              return new HarnessError({
                message: `Claude Code could not switch to ${input.route.model} at ${input.route.effort} effort in ${input.mode} mode: ${String(error)}`,
              });
            },
          });
          // Opened before the stream starts, so no steer can overtake the turn's own prompt.
          session.live = true;
          session.unanswered.clear();
          session.push({
            type: "user",
            message: { role: "user", content: input.text },
            parent_tool_use_id: null,
            uuid: input.turnId as UUID,
          });
          const events = turn(session, input);
          // Without `return`: Effect awaits it on interrupt, and a generator parked on the SDK would never settle it.
          const reader = { [Symbol.asyncIterator]: () => ({ next: () => events.next() }) };
          return Stream.fromAsyncIterable(reader, (error) => {
            end(input.threadId);
            return error instanceof HarnessError ? error : new HarnessError({ message: `Claude Code failed: ${String(error)}` });
          }).pipe(
            Stream.drainFork(input.steers.pipe(Stream.tap((text) => Effect.sync(() => say(session, text))))),
            Stream.onExit((exit) => (Exit.hasInterrupts(exit) ? stop(input.threadId, session, events) : Effect.void)),
          );
        }),
      ),
    respond: (threadId, requestId, resolution) => Effect.sync(() => sessions.get(threadId)?.waiting.get(requestId)?.(resolution)),
    reroute: (threadId, route) =>
      Effect.sync(() => {
        const session = sessions.get(threadId);
        if (!session?.live) return;
        // ponytail: a failed switch leaves the build on the plan's model, which its usage still records by model.
        // Upgrade: report it, once a harness event can say the route didn't change.
        session.rerouting = session.rerouting.then(() => applyRoute(session, route)).catch(() => undefined);
      }),
  };
};
