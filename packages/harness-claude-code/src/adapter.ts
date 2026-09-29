import { existsSync } from "node:fs";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { type HarnessAdapter, HarnessError, type HarnessEvent, type HarnessRunInput, type ThreadId } from "@verdandi/contracts";
import { Effect, Stream } from "effect";
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
  context: NormalizeContext;
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
      canUseTool: async () => ({ behavior: "deny", message: "Approvals arrive in a later Verdandi build." }),
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
    while (true) {
      const step = await session.next();
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
  };
};
