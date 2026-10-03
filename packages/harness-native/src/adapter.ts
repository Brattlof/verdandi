import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { VERSION } from "@anthropic-ai/sdk/version";
import {
  type HarnessAdapter,
  HarnessError,
  type HarnessEvent,
  type HarnessRunInput,
  type InteractionMode,
  listCost,
  type Resolution,
  type Route,
  type ThreadId,
} from "@verdandi/contracts";
import { Effect, Stream } from "effect";
import { type CacheBreaks, cacheBreak, fingerprint, type Sent } from "./cache-check.ts";
import { nativeCatalog } from "./catalog.ts";
import { access, fileTools, type Reach, runFileTool } from "./file-tools.ts";
import { modeNotes, opensFiles, planTool, sessionPrefix, turnContent } from "./prompt.ts";
import { runTerminal, type Terminal, terminalTool } from "./terminal.ts";
import {
  appendEntry,
  createTranscript,
  type Entry,
  entriesThrough,
  loadTranscript,
  requestMessages,
  type Transcript,
} from "./transcript.ts";

/** The running turn of a session: requests waiting for the user, steers waiting for the next safe point. */
type Turn = {
  readonly waiting: Map<string, (resolution: Resolution) => void>;
  readonly steers: string[];
  /** Plan mode until the user approves the plan; then the turn goes on building. */
  planning: boolean;
  /** The terminal command running, which an interrupt waits for until its process tree is gone. */
  running: Promise<unknown> | undefined;
};

/** One native session per thread, kept between turns. */
type Session = {
  readonly transcript: Transcript;
  /** The route the next request runs on: the turn's, until `reroute` moves it. */
  route: Route;
  /** The mode the agent last heard of; undefined after a resume, so the next turn says it again. */
  mode: InteractionMode | undefined;
  turn: Turn | undefined;
};

const maxTokens = 64_000;
const setKey = "Replace it with `verdandi key set anthropic` (or VERDANDI_ANTHROPIC_API_KEY), then restart verdandid.";

/** What each HTTP status from the Anthropic API means for the user, and the fix. */
const statusFailures: Record<number, string> = {
  400: "The Anthropic API refused the request.",
  401: `The Anthropic API rejected the API key. ${setKey}`,
  403: "The API key isn't allowed to do this, e.g. use this model. Check its workspace's permissions in the Anthropic Console, or pick another route.",
  404: "The Anthropic API doesn't know this model. Pick another route.",
  413: "The conversation is too large for one request. Start a new thread.",
  429: "The Anthropic API is rate-limiting this key, even after retries. Wait a minute and try again, or pick a Claude Code route.",
  529: "The Anthropic API is overloaded, even after retries. Try again shortly, or pick a Claude Code route.",
};

/** A failure of the turn, as the user reads it: the cause and the fix. Never holds the key. */
const failure = (error: unknown) => {
  if (error instanceof HarnessError) return error;
  if (error instanceof Anthropic.APIConnectionError)
    return new HarnessError({ message: `Couldn't reach the Anthropic API (${error.message}). Check the network, then try again.` });
  if (error instanceof Anthropic.APIError && error.status !== undefined) {
    const known =
      statusFailures[error.status] ??
      (error.status >= 500
        ? "The Anthropic API failed. Try again shortly, or pick a Claude Code route."
        : "The Anthropic API refused the request.");
    return new HarnessError({ message: `${known} (${error.message})` });
  }
  return new HarnessError({ message: `The native harness failed: ${error instanceof Error ? error.message : String(error)}` });
};

const unknownModel = (model: string) =>
  `The native harness doesn't run ${model}. Pick one of ${nativeCatalog.map((e) => e.model).join(", ")}.`;

/** Raises a request and waits for `respond`. Registered before it's reported, so an answer can never arrive first. */
async function* request(turn: Turn, event: (requestId: string) => HarnessEvent): AsyncGenerator<HarnessEvent, Resolution> {
  const requestId = randomUUID();
  const answered = new Promise<Resolution>((resolve) => turn.waiting.set(requestId, resolve));
  yield event(requestId);
  const resolution = await answered;
  turn.waiting.delete(requestId);
  return resolution;
}

const feedback = (r: Resolution) => (r.decision === "deny" && r.feedback ? ` Their feedback: ${r.feedback}` : "");

/** Why this turn may change nothing and run no command yet (`ask`, or `plan` before the plan is approved), or undefined. */
const heldBack = (turn: Turn, mode: InteractionMode) =>
  turn.planning
    ? `You're planning: change nothing and run no command until the user approves your plan with ${planTool}.`
    : mode === "ask"
      ? "This turn runs in ask mode: answer without changing anything or running commands."
      : undefined;

/**
 * Runs one tool call: the plan tool raises `plan.requested`, a file tool checks its path (asking outside the thread's
 * reach, ADR 0025), the terminal asks before every command, and a Verdandi tool that `ask`s raises
 * `approval.requested` first. A file tool or the terminal runs only in a session whose tool list has it.
 */
async function* runTool(
  use: Anthropic.ToolUseBlock,
  input: HarnessRunInput,
  session: Session,
  turn: Turn,
  local: { readonly reach: Reach; readonly terminal: Terminal; readonly signal: AbortSignal },
): AsyncGenerator<HarnessEvent, { readonly text: string; readonly isError?: boolean }> {
  const args = (typeof use.input === "object" && use.input !== null ? use.input : {}) as Record<string, unknown>;
  if (use.name === planTool) {
    if (!turn.planning) {
      const why =
        input.mode === "ask"
          ? "This turn runs in ask mode: answer without planning or changing anything."
          : "You're building already: go ahead without proposing a plan.";
      return { text: why, isError: true };
    }
    const plan = typeof args.plan === "string" ? args.plan : "";
    if (plan === "") return { text: "`plan` is required: the whole plan, as Markdown.", isError: true };
    const r = yield* request(turn, (requestId) => ({ type: "plan.requested", requestId, plan }));
    if (r.decision !== "allow")
      return {
        text: `The user rejected the plan.${feedback(r)} Keep planning, and propose a revised plan with ${planTool}.`,
        isError: true,
      };
    turn.planning = false;
    return {
      text: r.plan
        ? `The user approved the plan with edits. Build this version of it:\n\n${r.plan}`
        : "The user approved the plan. Build it now.",
    };
  }
  // A session from before the file tools or the terminal keeps the tool list it started with.
  const has = session.transcript.prefix.tools.some((t) => t.name === use.name);
  if (use.name === terminalTool && has) {
    const held = heldBack(turn, input.mode);
    if (held) return { text: held, isError: true };
    if (typeof args.command !== "string" || args.command.trim() === "") return { text: "`command` is required.", isError: true };
    // ponytail: every command asks; smart approvals (DESIGN §17) rate a command's risk later, never auto-approving a destructive one.
    const r = yield* request(turn, (requestId) => ({
      type: "approval.requested",
      requestId,
      toolName: use.name,
      input: { ...args, folder: input.cwd },
    }));
    if (r.decision !== "allow") return { text: `The user denied this.${feedback(r)}`, isError: true };
    const running = runTerminal(args, input.cwd, local.terminal, use.id, local.signal);
    turn.running = running;
    try {
      return await running;
    } finally {
      turn.running = undefined;
    }
  }
  const file = fileTools[use.name];
  if (file && has) {
    const held = file.writes ? heldBack(turn, input.mode) : undefined;
    if (held) return { text: held, isError: true };
    const path = file.path(args);
    if (path === "") return { text: "`path` is required.", isError: true };
    const allowed = access(path, input.cwd, local.reach, file.writes);
    if (allowed.kind === "refuse") return { text: allowed.why, isError: true };
    if (allowed.kind === "ask") {
      const note = allowed.note;
      const r = yield* request(turn, (requestId) => ({
        type: "approval.requested",
        requestId,
        toolName: use.name,
        input: { ...args, note },
      }));
      if (r.decision !== "allow") return { text: `The user denied this.${feedback(r)}`, isError: true };
    }
    return await runFileTool(file, args, input.cwd, local.reach);
  }
  const tool = input.tools?.find((t) => t.name === use.name);
  if (!tool) return { text: `There's no tool named ${use.name}.`, isError: true };
  if (tool.ask) {
    const r = yield* request(turn, (requestId) => ({ type: "approval.requested", requestId, toolName: use.name, input: args }));
    if (r.decision !== "allow") return { text: `The user denied this.${feedback(r)}`, isError: true };
  }
  return await tool.call(args, { threadId: input.threadId, turnId: input.turnId });
}

/**
 * Verdandi's own agent loop on the Anthropic Messages API (DESIGN §9.4, ADR 0022), metered at list price. Each
 * thread keeps one session, whose system prompt and tool list are fixed when it opens and whose transcript is kept
 * in `sessionsDir`, so a thread resumes after a restart. Its file tools work in the thread's folder and `reach`, and its
 * terminal runs commands through `terminal`, whose outputs folder `read_file` may read. Each request is checked against the session's last one, and a
 * break of the prompt cache is logged as a warning, or thrown with `cacheBreaks: "throw"`, as every test sets. Tests
 * pass the fake provider's `fetch`.
 */
export const makeNativeAdapter = (options: {
  readonly apiKey: string;
  readonly sessionsDir: string;
  readonly reach: Reach;
  readonly terminal: Terminal;
  readonly fetch?: typeof globalThis.fetch;
  readonly cacheBreaks?: CacheBreaks;
}): HarnessAdapter => {
  // Everything explicit, so nothing in the environment meant for Claude Code (a base URL, a token, debug logging) applies here.
  const client = new Anthropic({
    apiKey: options.apiKey,
    authToken: null,
    baseURL: "https://api.anthropic.com",
    logLevel: "warn",
    ...(options.fetch && { fetch: options.fetch }),
  });
  const sessions = new Map<ThreadId, Session>();
  const harnessVersion = `native (@anthropic-ai/sdk ${VERSION})`;
  const reach = { ...options.reach, readable: [...options.reach.readable, options.terminal.outputs] };
  // Per transcript, so a fork (a new transcript) starts fresh; a diagnostic, kept in memory only.
  const lastSent = new WeakMap<Transcript, Sent>();

  /** Fingerprints a request and names what broke the cache since the session's last one (DESIGN §9.4). */
  const checkCache = (session: Session, body: Anthropic.MessageCreateParams) => {
    const sent = fingerprint(session.route, body);
    const previous = lastSent.get(session.transcript);
    lastSent.set(session.transcript, sent);
    const what = previous && cacheBreak(previous, sent);
    if (!what) return;
    const message = `Native session ${session.transcript.id} broke the prompt cache: ${what}. Within a session the system prompt, tools and earlier messages never change, and the model, thinking and effort only with the route (ADR 0022).`;
    if (options.cacheBreaks === "throw") throw new HarnessError({ message });
    console.warn(message);
  };

  /** The thread's session for this turn, and what to report before it starts. */
  const open = (input: HarnessRunInput): { readonly session: Session; readonly events: HarnessEvent[] } => {
    const dir = options.sessionsDir;
    const live = sessions.get(input.threadId);
    const bind = (transcript: Transcript, mode: InteractionMode | undefined, events: HarnessEvent[]) => {
      const session: Session = { transcript, route: input.route, mode, turn: undefined };
      sessions.set(input.threadId, session);
      return { session, events };
    };
    const started = (transcript: Transcript): HarnessEvent => ({ type: "session.started", sessionId: transcript.id, harnessVersion });
    const notice = (text: string): HarnessEvent => ({ type: "item", item: { kind: "notice", text } });
    const fresh = (events: HarnessEvent[]) => {
      const transcript = createTranscript(dir, randomUUID(), sessionPrefix(input.cwd, input.tools ?? [], options.reach.folders));
      return bind(transcript, "build", [started(transcript), ...events]);
    };
    const resumed = input.resumeSessionId
      ? live?.transcript.id === input.resumeSessionId
        ? live.transcript
        : loadTranscript(dir, input.resumeSessionId)
      : undefined;
    if (input.fork) {
      // A revert (DESIGN §13): a new session holding the old one's messages through the turn it goes back to.
      const kept = resumed && entriesThrough(resumed, input.fork.atTurnId);
      if (resumed && kept) {
        const transcript = createTranscript(dir, randomUUID(), resumed.prefix, kept);
        return bind(transcript, undefined, [started(transcript)]);
      }
      if (resumed)
        return bind(resumed, undefined, [
          notice(
            "The native session doesn't have the turn the revert goes back to, so it resumed the conversation as it was: the agent still remembers the reverted turns.",
          ),
        ]);
    }
    if (resumed) return live?.transcript === resumed ? { session: live, events: [] } : bind(resumed, undefined, []);
    if (input.resumeSessionId)
      return fresh([
        notice(
          "The native session's transcript is gone, so this turn starts a new conversation: the agent doesn't remember the thread's earlier turns.",
        ),
      ]);
    return fresh([]);
  };

  /** One turn of the loop: call the model, run the tools it asks for, repeat until it's done, a limit stops it, or an interrupt. */
  async function* loop(
    session: Session,
    input: HarnessRunInput,
    content: Anthropic.ContentBlockParam[],
    turn: Turn,
    signal: AbortSignal,
  ): AsyncGenerator<HarnessEvent> {
    // After an interrupt nothing more reaches the transcript: the next turn builds on what was committed.
    const append = (message: Entry["message"]) => {
      if (signal.aborted) throw new HarnessError({ message: "The turn was interrupted." });
      appendEntry(session.transcript, { turnId: input.turnId, message });
    };
    const finished = (status: "success" | "error" | "limit", error?: string): HarnessEvent => ({
      type: "turn.finished",
      status,
      ...(error !== undefined && { error }),
    });
    const text = (steer: string): Anthropic.TextBlockParam => ({ type: "text", text: steer });
    append({ role: "user", content });
    let spent = 0;
    for (let requests = 1; ; requests++) {
      const limits = input.limits;
      // ponytail: counts this run's model calls, not the task's; upgrade once turns are counted per task (as for Claude Code, ADR 0005).
      if (limits?.maxTurns !== undefined && requests > limits.maxTurns) {
        yield finished("limit", `Stopped at the task's ${limits.maxTurns}-turn limit.`);
        return;
      }
      const { model, effort } = session.route;
      const entry = nativeCatalog.find((e) => e.model === model);
      if (!entry) throw new HarnessError({ message: unknownModel(model) });
      const body: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: maxTokens,
        system: session.transcript.prefix.system,
        tools: session.transcript.prefix.tools,
        // The second breakpoint moves along with the conversation; the first ends the fixed prefix.
        cache_control: { type: "ephemeral" },
        messages: requestMessages(session.transcript.entries),
        // A model without effort levels (Haiku 4.5) takes neither effort nor adaptive thinking.
        ...(entry.efforts.length === 0 ? {} : { thinking: { type: "adaptive" as const }, output_config: { effort } }),
      };
      checkCache(session, body);
      const stream = client.messages.stream(body, { signal });
      for await (const event of stream)
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield { type: "text.delta", text: event.delta.text };
      const reply = await stream.finalMessage();
      // Whole and unchanged, thinking blocks included: they go back to the model exactly as it sent them.
      append({ role: "assistant", content: reply.content as Anthropic.ContentBlockParam[] });
      const tokens = {
        inputTokens: reply.usage.input_tokens,
        outputTokens: reply.usage.output_tokens,
        cacheReadTokens: reply.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: reply.usage.cache_creation_input_tokens ?? 0,
      };
      const costUsd = listCost(entry.price, tokens);
      spent += costUsd;
      yield { type: "usage", model, accessMode: "metered", ...tokens, costUsd };
      for (const block of reply.content)
        if (block.type === "text" && block.text !== "") yield { type: "item", item: { kind: "assistant.message", text: block.text } };
      if (reply.stop_reason === "refusal") {
        const why = reply.stop_details?.category ? ` (${reply.stop_details.category})` : "";
        yield finished("error", `The model declined this request${why}. Rephrase it, or pick another route.`);
        return;
      }
      const uses = reply.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (reply.stop_reason === "max_tokens") {
        yield finished(
          "error",
          `The reply hit the ${maxTokens.toLocaleString("en-US")}-token output limit before it finished. Ask for less at once.`,
        );
        return;
      }
      if (limits?.maxCost !== undefined && limits.spentUsd + spent > limits.maxCost) {
        yield finished("limit", `Stopped at the task's $${limits.maxCost} cost limit.`);
        return;
      }
      if (uses.length === 0) {
        // Steers that came after the agent's last tool call: hand them over, and the turn goes on until it answers them.
        const steers = turn.steers.splice(0);
        if (steers.length === 0) {
          yield finished("success");
          return;
        }
        append({ role: "user", content: steers.map(text) });
        continue;
      }
      // ponytail: tools run one at a time; upgrade to running the ones that are safe together in parallel (DESIGN §9.4) once there are slow ones.
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        yield { type: "item", item: { kind: "tool.call", toolUseId: use.id, name: use.name, input: use.input } };
        const result = yield* runTool(use, input, session, turn, { reach, terminal: options.terminal, signal });
        const isError = result.isError === true;
        results.push({ type: "tool_result", tool_use_id: use.id, content: result.text, ...(isError && { is_error: true }) });
        yield { type: "item", item: { kind: "tool.result", toolUseId: use.id, isError, content: result.text } };
      }
      // All results in one message, then the steers: the next safe point (DESIGN §9.4).
      append({ role: "user", content: [...results, ...turn.steers.splice(0).map(text)] });
    }
  }

  return {
    id: "native",
    run: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (!nativeCatalog.some((e) => e.model === input.route.model))
            return yield* new HarnessError({ message: unknownModel(input.route.model) });
          const { session, events } = yield* Effect.try({
            try: () => open(input),
            catch: (e) =>
              new HarnessError({
                message: `The native session's transcript can't be opened (${e instanceof Error ? e.message : String(e)}). Check that ${options.sessionsDir} is writable.`,
              }),
          });
          // Read before the turn starts: a missing attachment fails the turn with its name.
          const canOpenFiles = opensFiles(session.transcript.prefix);
          const content = yield* Effect.try({
            try: () => turnContent(input, session.mode === input.mode ? undefined : modeNotes[input.mode], canOpenFiles),
            catch: (e) =>
              new HarnessError({
                message: `An attachment of this turn can't be read (${String(e)}). It may have been deleted from the profile's attachments folder; attach it again.`,
              }),
          });
          session.mode = input.mode;
          session.route = input.route;
          if (!canOpenFiles && input.attachments?.some((a) => a.kind === "file"))
            events.push({
              type: "item",
              item: {
                kind: "notice",
                text: "This native session started before the agent could open files, so it sees only the attached files' names. A new thread can open them.",
              },
            });
          const turn: Turn = { waiting: new Map(), steers: [], planning: input.mode === "plan", running: undefined };
          session.turn = turn;
          const controller = new AbortController();
          const generator = loop(session, input, content, turn, controller.signal);
          // Without `return`: Effect would await it on interrupt, and a generator parked on an approval never settles it.
          const reader = { [Symbol.asyncIterator]: () => ({ next: () => generator.next() }) };
          return Stream.fromAsyncIterable(reader, failure).pipe(
            (s) => (events.length > 0 ? Stream.concat(Stream.fromIterable(events), s) : s),
            Stream.drainFork(input.steers.pipe(Stream.tap((steer) => Effect.sync(() => void turn.steers.push(steer))))),
            // An interrupt aborts the request in flight, so a half-streamed reply is never committed, and kills a
            // running command, waiting until its process tree is gone.
            Stream.onExit(() =>
              Effect.andThen(
                Effect.sync(() => {
                  controller.abort();
                  if (session.turn === turn) session.turn = undefined;
                }),
                Effect.promise(() => turn.running ?? Promise.resolve()),
              ),
            ),
          );
        }),
      ),
    respond: (threadId, requestId, resolution) => Effect.sync(() => sessions.get(threadId)?.turn?.waiting.get(requestId)?.(resolution)),
    reroute: (threadId, route) =>
      Effect.sync(() => {
        const session = sessions.get(threadId);
        // The model is a per-request parameter: the turn's next request runs on `route` (ADR 0022).
        if (session?.turn) session.route = route;
      }),
    close: (threadId) =>
      Effect.sync(() => {
        if (threadId === undefined) sessions.clear();
        else sessions.delete(threadId);
      }),
  };
};
