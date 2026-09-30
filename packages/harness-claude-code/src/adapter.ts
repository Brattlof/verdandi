import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { type CanUseTool, type PermissionResult, query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type HarnessAdapter,
  HarnessError,
  type HarnessEvent,
  type HarnessRunInput,
  Question,
  type Resolution,
  type ThreadId,
} from "@verdandi/contracts";
import { Effect, Option, Schema, Stream } from "effect";
import { initialContext, type NormalizeContext, normalize } from "./normalize.ts";

export type QueryFn = typeof query;

/** Turn ids are UUIDs by contract, so they can be the prompt uuid a later fork points at (ADR 0004). */
type UUID = NonNullable<SDKUserMessage["uuid"]>;

/** The user's installed Claude Code CLI (ADR 0001), or undefined when it isn't on PATH. */
export const findClaude = () => Bun.which("claude") ?? undefined;

/** One long-lived Claude Code process per thread, fed through a single prompt stream. */
type Session = {
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
};

const decodeQuestions = Schema.decodeUnknownOption(Schema.Struct({ questions: Schema.Array(Question) }));

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

  // Every tool the user's own settings don't allow lands here; AskUserQuestion becomes a user-input request.
  const canUseTool: CanUseTool = (toolName, toolInput, { signal }) =>
    new Promise((resolve) => {
      const requestId = randomUUID();
      const answer = (resolution: Resolution) => {
        waiting.delete(requestId);
        resolve(toPermission(toolInput, resolution));
      };
      waiting.set(requestId, answer);
      signal.addEventListener("abort", () => answer({ decision: "deny" }), { once: true });
      const asked = toolName === "AskUserQuestion" ? decodeQuestions(toolInput) : Option.none();
      raise(
        Option.isSome(asked)
          ? { type: "user-input.requested", requestId, questions: asked.value.questions }
          : { type: "approval.requested", requestId, toolName, input: toolInput },
      );
    });

  const q = queryFn({
    prompt,
    options: {
      pathToClaudeCodeExecutable: claudePath,
      cwd: input.cwd,
      model: input.route.model,
      effort: input.route.effort,
      ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
      includePartialMessages: true,
      // Connectors attach nondeterministically and would change the tool list between turns (ADR 0001).
      settings: { disableClaudeAiConnectors: true },
      canUseTool,
    },
  });
  // One iterator for the session's lifetime: leaving a for-await early would close the CLI (ADR 0003).
  const iterator = q[Symbol.asyncIterator]();
  return {
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
  };
};

export const makeClaudeCodeAdapter = (options: { readonly claudePath: string; readonly query?: QueryFn }): HarnessAdapter => {
  const sessions = new Map<ThreadId, Session>();
  const end = (threadId: ThreadId) => {
    sessions.get(threadId)?.close();
    sessions.delete(threadId);
  };

  async function* turn(session: Session, input: HarnessRunInput): AsyncGenerator<HarnessEvent> {
    session.push({ type: "user", message: { role: "user", content: input.text }, parent_tool_use_id: null, uuid: input.turnId as UUID });
    // Read lazily: a read left pending when the turn finishes would swallow the next turn's first message.
    let pending: Promise<IteratorResult<SDKMessage>> | undefined;
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
      const { events, context } = normalize(step.value, session.context);
      session.context = context;
      yield* events;
      const finished = events.find((e) => e.type === "turn.finished");
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
          const session = sessions.get(input.threadId) ?? openSession(options.query ?? query, options.claudePath, input);
          sessions.set(input.threadId, session);
          return Stream.fromAsyncIterable(turn(session, input), (error) => {
            end(input.threadId);
            return error instanceof HarnessError ? error : new HarnessError({ message: `Claude Code failed: ${String(error)}` });
          });
        }),
      ),
    respond: (threadId, requestId, resolution) => Effect.sync(() => sessions.get(threadId)?.waiting.get(requestId)?.(resolution)),
  };
};
