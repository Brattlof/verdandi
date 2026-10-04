import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { VERSION } from "@anthropic-ai/sdk/version";
import {
  describeFailure,
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
import { compress, compressAt, estimateTokens, retryAt, tailBudget } from "./compress.ts";
import { indexSkills, readContext, type SkillEntry } from "./context.ts";
import { concurrently, delegateArgs, delegateTool, summaryOf } from "./delegate.ts";
import { access, fileTools, type Reach, runFileTool } from "./file-tools.ts";
import { closeMcp, type McpTools, openMcp } from "./mcp.ts";
import { childContent, modeNotes, opensFiles, planTool, sessionPrefix, turnContent } from "./prompt.ts";
import { classify } from "./provider-failure.ts";
import { runTerminal, stopTrying, type Terminal, terminalTool } from "./terminal.ts";
import { callTool, describeTool, searchDeferred, searchTool, type ToolSearch, unwrapCall } from "./tool-search.ts";
import {
  appendCompression,
  appendEntry,
  compressionsThrough,
  createTranscript,
  type Entry,
  entriesThrough,
  loadTranscript,
  requestMessages,
  saidEffort,
  type Transcript,
} from "./transcript.ts";

/**
 * The running turn of a session: requests waiting for the user, steers waiting for the next safe point. A delegated
 * child runs a turn of its own that shares its parent's requests, running commands and spend (DESIGN §9.4).
 */
type Turn = {
  readonly waiting: Map<string, (resolution: Resolution) => void>;
  readonly steers: string[];
  /** Plan mode until the user approves the plan; then the turn goes on building. */
  planning: boolean;
  /** The terminal commands running, which an interrupt waits for until their process trees are gone. */
  readonly running: Set<Promise<unknown>>;
  /** What the turn's requests, its children's included, cost so far: what counts against the task's `maxCost`. */
  readonly spent: { usd: number };
  /** 0 for the thread's own session, 1 for a child it delegated to, and so on. */
  readonly depth: number;
  /** Terminal commands denied in a row, by the user or smart approvals: the third tells the agent to stop trying. */
  denials: number;
};

/** One native session per thread, kept between turns. */
type Session = {
  readonly transcript: Transcript;
  /** The route the next request runs on: the turn's, until `reroute` moves it. */
  route: Route;
  /** The mode the agent last heard of; undefined after a resume, so the next turn says it again. */
  mode: InteractionMode | undefined;
  turn: Turn | undefined;
  /** The MCP servers it's connected to, which stop with it. */
  readonly mcp: McpTools | undefined;
};

/** The output each request leaves room for (`max_tokens`). */
export const maxTokens = 64_000;
/** How long the API keeps a prompt cached (the 5-minute TTL): a session idle longer has a cold cache, so pruning it is free. */
const cacheTtlMs = 5 * 60_000;
/** The beta that takes an effort-only system message within a conversation (ADR 0022). */
const perMessageEffort = "mid-conversation-output-config-2026-07-01";
const setKey = "Replace it with `verdandi key set anthropic` (or VERDANDI_ANTHROPIC_API_KEY), then restart verdandid.";

/** What each HTTP status that isn't a provider failure (`classify`) means for the user, and the fix. */
const statusFailures: Record<number, string> = {
  400: "The Anthropic API refused the request.",
  403: "The API key isn't allowed to do this, e.g. use this model. Check its workspace's permissions in the Anthropic Console, or pick another route.",
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

type ToolResult = { readonly text: string; readonly isError?: boolean };

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
 * reach, ADR 0025), the terminal asks before every command, `delegate_task` runs a child session, and a Verdandi tool
 * that `ask`s raises `approval.requested` first. A file tool, the terminal or `delegate_task` runs only in a session
 * whose tool list has it.
 */
async function* runTool(
  use: Anthropic.ToolUseBlock,
  input: HarnessRunInput,
  session: Session,
  turn: Turn,
  local: {
    readonly reach: Reach;
    readonly terminal: Terminal;
    readonly signal: AbortSignal;
    /** Runs a `delegate_task` call in a child session. */
    readonly delegate: (use: Anthropic.ToolUseBlock) => AsyncGenerator<HarnessEvent, ToolResult>;
  },
): AsyncGenerator<HarnessEvent, ToolResult> {
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
  // A session from before the file tools, the terminal or delegation keeps the tool list it started with.
  const { tools, deferred } = session.transcript.prefix;
  const has = tools.some((t) => t.name === use.name) || (deferred?.some((t) => t.name === use.name) ?? false);
  // The bridge (DESIGN §9.4): what it finds is the servers' own text, so it's screened like their results.
  const screened = async (text: string) => (input.screen ? await input.screen(text) : text);
  if (deferred && has && use.name === searchTool) return { text: await screened(searchDeferred(deferred, String(args.query ?? ""))) };
  if (deferred && has && use.name === describeTool) {
    const found = deferred.find((t) => t.name === args.name);
    if (!found) return { text: `There's no tool named ${String(args.name)} to describe. Find one with ${searchTool}.`, isError: true };
    return { text: await screened(JSON.stringify(found.input_schema)) };
  }
  // A `tool_call` naming a deferred tool already runs as that tool (`unwrapCall`); this one names none.
  if (deferred && has && use.name === callTool)
    return { text: `There's no tool named ${String(args.name)} to call. Find one with ${searchTool}.`, isError: true };
  if (use.name === delegateTool && has) return yield* local.delegate(use);
  if (use.name === terminalTool && has) {
    const held = heldBack(turn, input.mode);
    if (held) return { text: held, isError: true };
    if (typeof args.command !== "string" || args.command.trim() === "") return { text: "`command` is required.", isError: true };
    // Smart approvals, when on, rate it first (DESIGN §17): an allowed command runs unasked, a denied one never runs, and
    // anything else asks the user, as every command does while they're off.
    const rated = input.guard ? await input.guard(args.command) : undefined;
    if (rated && rated.verdict !== "ask")
      yield { type: "item", item: { kind: "approval.auto", toolUseId: use.id, decision: rated.verdict, reason: rated.reason } };
    const denied = (why: string) => {
      turn.denials++;
      return { text: `${why}${turn.denials >= 3 ? stopTrying : ""}`, isError: true };
    };
    if (rated?.verdict === "deny") return denied(`Smart approvals refused this command: ${rated.reason}.`);
    if (rated?.verdict !== "allow") {
      const note = rated && { note: `Smart approvals sent this to you: ${rated.reason}.` };
      const r = yield* request(turn, (requestId) => ({
        type: "approval.requested",
        requestId,
        toolName: use.name,
        input: { ...args, folder: input.cwd, ...note },
      }));
      if (r.decision !== "allow") return denied(`The user denied this.${feedback(r)}`);
    }
    turn.denials = 0;
    const running = runTerminal(args, input.cwd, local.terminal, use.id, local.signal);
    turn.running.add(running);
    try {
      return await running;
    } finally {
      turn.running.delete(running);
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
  const mcp = has ? session.mcp?.byName.get(use.name) : undefined;
  if (mcp) {
    // In ask and plan mode every MCP tool asks, since Verdandi can't tell which ones change things.
    if (mcp.ask || heldBack(turn, input.mode)) {
      const r = yield* request(turn, (requestId) => ({ type: "approval.requested", requestId, toolName: use.name, input: args }));
      if (r.decision !== "allow") return { text: `The user denied this.${feedback(r)}`, isError: true };
    }
    const result = await mcp.connection.call(mcp.tool, args, local.signal);
    // Untrusted data: screened like Verdandi's search tools' results (DESIGN §17).
    return { ...result, text: input.screen ? await input.screen(result.text) : result.text };
  }
  const tool = input.tools?.find((t) => t.name === use.name);
  if (!tool)
    return {
      text: use.name.startsWith("mcp__")
        ? `The MCP server behind ${use.name} isn't connected in this session. Carry on without it.`
        : `There's no tool named ${use.name}.`,
      isError: true,
    };
  if (tool.ask) {
    const r = yield* request(turn, (requestId) => ({ type: "approval.requested", requestId, toolName: use.name, input: args }));
    if (r.decision !== "allow") return { text: `The user denied this.${feedback(r)}`, isError: true };
  }
  return await tool.call(args, { threadId: input.threadId, turnId: input.turnId });
}

/**
 * Verdandi's own agent loop on the Anthropic Messages API (DESIGN §9.4, ADR 0022), metered at list price. Each
 * thread keeps one session, whose system prompt and tool list are fixed when it opens and whose transcript is kept
 * in `sessionsDir`, so a thread resumes after a restart. A new session's prompt holds the folder's context file and an
 * index of `skills`, each scanned through the turn's `scan`, which leaves a flagged one out. Its file tools work in the thread's folder and `reach`, and its
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
  /** The skills a new session's index lists (DESIGN §14.4), read when it opens. */
  readonly skills?: () => readonly SkillEntry[];
  /**
   * How a new session finds the MCP tools it defers once they're many (DESIGN §9.4): the API's own search (`server`,
   * the default), or Verdandi's bridge (`bridge`), for a provider without one.
   */
  readonly toolSearch?: ToolSearch;
  /** False leaves sessions uncompressed (DESIGN §16): the recall exam, whose policies decide what a request keeps. */
  readonly compress?: boolean;
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
  // Tool results a compression moved to disk, which read_file may open (DESIGN §16).
  const prunedDir = join(options.sessionsDir, "pruned");
  const reach = { ...options.reach, readable: [...options.reach.readable, options.terminal.outputs, prunedDir] };
  // Per transcript, so a fork (a new transcript) starts fresh; a diagnostic, kept in memory only.
  const lastSent = new WeakMap<Transcript, Sent>();
  /** Per transcript, the last request's prompt tokens and when it was sent: what compression triggers on (DESIGN §16). */
  const lastPrompt = new WeakMap<Transcript, { readonly tokens: number; readonly at: number }>();
  /** Transcripts whose last compression failed: tried again only past `retryAt` of the window. */
  const failedCompression = new WeakSet<Transcript>();
  /**
   * The providers and models this process reported failing, as `provider model` (model empty for the whole provider): a
   * later success on one reports it's over. ponytail: kept in memory, so after a restart a failure lasts until its `until`;
   * report every turn's first success instead if that turns out to keep a recovered provider out too long.
   */
  const failing = new Set<string>();

  /** Fingerprints a request and names what broke the cache since the session's last one (DESIGN §9.4). */
  const checkCache = (session: Session, body: Anthropic.MessageCreateParams) => {
    const sent = fingerprint(session.route, body, session.transcript.compressions.length);
    const previous = lastSent.get(session.transcript);
    lastSent.set(session.transcript, sent);
    const what = previous && cacheBreak(previous, sent);
    if (!what) return;
    const message = `Native session ${session.transcript.id} broke the prompt cache: ${what}. Within a session the system prompt and tools never change, earlier messages only at a compression, and the model, thinking and effort only with the route (ADR 0022).`;
    if (options.cacheBreaks === "throw") throw new HarnessError({ message });
    console.warn(message);
  };

  /** The thread's session for this turn, and what to report before it starts. */
  const open = async (input: HarnessRunInput): Promise<{ readonly session: Session; readonly events: HarnessEvent[] }> => {
    const dir = options.sessionsDir;
    const live = sessions.get(input.threadId);
    const started = (transcript: Transcript): HarnessEvent => ({ type: "session.started", sessionId: transcript.id, harnessVersion });
    const notice = (text: string): HarnessEvent => ({ type: "item", item: { kind: "notice", text } });
    /** The MCP config for this turn: a broken one fails the turn, naming the file and key. */
    const mcpConfig = async (read: NonNullable<HarnessRunInput["mcp"]>) => {
      try {
        return await read();
      } catch (e) {
        throw new HarnessError({ message: e instanceof Error ? e.message : String(e) });
      }
    };
    /** Connects a resumed session again to the MCP servers its tool list has tools of (DESIGN §9.4). */
    const reconnect = async (prefix: Transcript["prefix"], events: HarnessEvent[]) => {
      const names = new Set([...prefix.tools, ...(prefix.deferred ?? [])].flatMap((t) => (t.name.startsWith("mcp__") ? [t.name] : [])));
      if (names.size === 0 || !input.mcp) return undefined;
      const config = await mcpConfig(input.mcp);
      const opened = await openMcp(config.servers, input.cwd, names);
      events.push(...[...config.notices, ...opened.notices].map(notice));
      return opened.tools;
    };
    /**
     * Makes `transcript` the thread's session. It takes over the live session's MCP servers when it keeps the same tool
     * list (a fork), else they stop, and it gets `opened` (a new session's) or connects again (a resumed one's).
     */
    const bind = async (transcript: Transcript, mode: InteractionMode | undefined, events: HarnessEvent[], opened?: McpTools) => {
      const kept = live && live.transcript.prefix === transcript.prefix ? live.mcp : undefined;
      if (live && live.mcp !== kept) await closeMcp(live.mcp);
      const mcp = opened ?? kept ?? (await reconnect(transcript.prefix, events));
      const session: Session = { transcript, route: input.route, mode, turn: undefined, mcp };
      sessions.set(input.threadId, session);
      return { session, events };
    };
    // Read once, when the session opens: the transcript keeps them, so a resume builds the same prompt (DESIGN §9.4).
    // Without `scan` nothing unscanned goes in.
    const fresh = async (events: HarnessEvent[]) => {
      const { scan } = input;
      const context = scan && (await readContext(input.cwd, scan));
      const skills = scan ? await indexSkills(options.skills?.() ?? [], scan) : [];
      const delegates = (input.delegate?.maxDepth ?? 0) > 0;
      // Its MCP servers' tools are fixed in its tool list now; tools a server adds later reach the next session.
      const config = input.mcp && (await mcpConfig(input.mcp));
      const mcp = config && (await openMcp(config.servers, input.cwd));
      const prefix = sessionPrefix(
        input.cwd,
        input.tools ?? [],
        options.reach.folders,
        { context, skills, delegates },
        mcp?.definitions,
        options.toolSearch,
      );
      const transcript = createTranscript(dir, randomUUID(), prefix);
      const flagged = skills.filter((s) => s.flagged).map((s) => s.name);
      return bind(
        transcript,
        "build",
        [
          started(transcript),
          ...events,
          ...[...(config?.notices ?? []), ...(mcp?.notices ?? [])].map(notice),
          ...(context && "blocked" in context
            ? [
                notice(
                  `${context.file} was left out of this session's prompt: Verdandi's injection scan flagged it, so the agent works without the project's conventions. Fix it, then start a new thread to give them back.`,
                ),
              ]
            : []),
          ...(flagged.length > 0
            ? [
                notice(
                  `The skills index leaves out the description of ${flagged.join(", ")}: Verdandi's injection scan flagged ${flagged.length === 1 ? "it" : "them"}. skill_view still shows the skill, under a warning.`,
                ),
              ]
            : []),
        ],
        mcp?.tools,
      );
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
        const transcript = createTranscript(dir, randomUUID(), resumed.prefix, kept, compressionsThrough(resumed, kept.length));
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
    // A turn's own effort (DESIGN §8.7 auto effort) goes in as an effort message before it, which keeps the cache; the
    // next turn without one goes back to the route's the same way. A model without effort levels takes neither.
    const wanted = input.effort ?? session.route.effort;
    const levels = nativeCatalog.find((e) => e.model === session.route.model)?.efforts ?? [];
    if (levels.length > 0 && wanted !== (saidEffort(session.transcript.entries) ?? session.route.effort))
      append({ role: "system", content: [], output_config: { effort: wanted } });
    append({ role: "user", content });
    for (let requests = 1; ; requests++) {
      const limits = input.limits;
      // What the turn's children spent counts too (DESIGN §9.4).
      if (limits?.maxCost !== undefined && limits.spentUsd + turn.spent.usd > limits.maxCost) {
        yield finished("limit", `Stopped at the task's $${limits.maxCost} cost limit.`);
        return;
      }
      // The task's earlier turns' model calls count too, reported as they're made so an interrupt doesn't lose them.
      if (limits?.maxTurns !== undefined) {
        if (limits.spentTurns + requests > limits.maxTurns) {
          yield finished("limit", `Stopped at the task's ${limits.maxTurns}-turn limit.`);
          return;
        }
        yield { type: "model.called" };
      }
      const { model, effort } = session.route;
      const entry = nativeCatalog.find((e) => e.model === model);
      if (!entry) throw new HarnessError({ message: unknownModel(model) });
      if (turn.depth === 0 && options.compress !== false) yield* compressIfDue(session, input, entry.context, signal);
      const body: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: maxTokens,
        system: session.transcript.prefix.system,
        tools: session.transcript.prefix.tools,
        // The second breakpoint moves along with the conversation; the first ends the fixed prefix.
        cache_control: { type: "ephemeral" },
        messages: requestMessages(session.transcript.entries, entry.efforts.length > 0, session.transcript.compressions.at(-1)),
        // A model without effort levels (Haiku 4.5) takes neither effort nor adaptive thinking.
        ...(entry.efforts.length === 0 ? {} : { thinking: { type: "adaptive" as const }, output_config: { effort } }),
      };
      checkCache(session, body);
      let reply: Anthropic.Message;
      try {
        const perTurn = body.messages.some((m) => m.role === "system");
        const stream = client.messages.stream(body, { signal, ...(perTurn && { headers: { "anthropic-beta": perMessageEffort } }) });
        for await (const event of stream)
          if (event.type === "content_block_delta" && event.delta.type === "text_delta")
            yield { type: "text.delta", text: event.delta.text };
        reply = await stream.finalMessage();
      } catch (e) {
        const failed = signal.aborted ? undefined : classify(e, model);
        // A child's failure goes back to the agent that delegated to it, which decides what's next.
        if (!failed || turn.depth > 0) throw e;
        failing.add(`${entry.provider} ${failed.model ?? ""}`);
        // Verdandi records it and answers: allowed once `reroute` moved the turn to a fallback, else why it stops (DESIGN §9.5).
        const r = yield* request(turn, (requestId) => ({ type: "provider.failed", requestId, provider: entry.provider, ...failed }));
        if (r.decision === "allow") continue;
        const why =
          r.decision === "deny" && r.feedback
            ? r.feedback
            : `${describeFailure({ provider: entry.provider, ...failed })}. Try again then, or pick another route.`;
        throw new HarnessError({ message: `${why} The API said: ${failed.error}${failed.reason === "auth" ? ` ${setKey}` : ""}` });
      }
      const recovered = [`${entry.provider} ${model}`, `${entry.provider} `].filter((key) => failing.delete(key));
      if (recovered.length > 0) yield { type: "provider.succeeded", provider: entry.provider, model };
      // Whole and unchanged, thinking blocks included: they go back to the model exactly as it sent them.
      append({ role: "assistant", content: reply.content as Anthropic.ContentBlockParam[] });
      const tokens = {
        inputTokens: reply.usage.input_tokens,
        outputTokens: reply.usage.output_tokens,
        cacheReadTokens: reply.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: reply.usage.cache_creation_input_tokens ?? 0,
      };
      lastPrompt.set(session.transcript, { tokens: tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens, at: Date.now() });
      const costUsd = listCost(entry.price, tokens);
      turn.spent.usd += costUsd;
      yield { type: "usage", model, accessMode: "metered", ...tokens, costUsd };
      for (const block of reply.content)
        if (block.type === "text" && block.text !== "") yield { type: "item", item: { kind: "assistant.message", text: block.text } };
      if (reply.stop_reason === "refusal") {
        const why = reply.stop_details?.category ? ` (${reply.stop_details.category})` : "";
        yield finished("error", `The model declined this request${why}. Rephrase it, or pick another route.`);
        return;
      }
      // A bridge's tool_call runs as the tool it names, under that name (DESIGN §9.4).
      const uses = reply.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((use) => unwrapCall(use, session.transcript.prefix.deferred));
      if (reply.stop_reason === "max_tokens") {
        yield finished(
          "error",
          `The reply hit the ${maxTokens.toLocaleString("en-US")}-token output limit before it finished. Ask for less at once.`,
        );
        return;
      }
      if (limits?.maxCost !== undefined && limits.spentUsd + turn.spent.usd > limits.maxCost) {
        yield finished("limit", `Stopped at the task's $${limits.maxCost} cost limit.`);
        return;
      }
      // The API paused a long run of its own tools (tool search): sending the conversation again lets it go on.
      if (reply.stop_reason === "pause_turn") continue;
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
      // Consecutive delegate_task calls run together, at most `maxConcurrent` at once (DESIGN §9.4).
      // ponytail: other tools run one at a time; upgrade to running the ones that are safe together in parallel (DESIGN §9.4) once there are slow ones.
      const results: Anthropic.ToolResultBlockParam[] = [];
      const local = {
        reach,
        terminal: options.terminal,
        signal,
        delegate: (use: Anthropic.ToolUseBlock) => child(use, session, input, turn, signal),
      };
      for (let i = 0; i < uses.length; ) {
        const together = uses[i]?.name === delegateTool ? uses.slice(i).findIndex((u) => u.name !== delegateTool) : 1;
        const batch = uses.slice(i, together < 0 ? uses.length : i + together);
        i += batch.length;
        for (const use of batch) yield { type: "item", item: { kind: "tool.call", toolUseId: use.id, name: use.name, input: use.input } };
        const done = yield* concurrently(
          batch.map((use) => () => runTool(use, input, session, turn, local)),
          input.delegate?.maxConcurrent ?? 1,
        );
        for (const [k, use] of batch.entries()) {
          const result = done[k] ?? { text: "The tool didn't run.", isError: true };
          const isError = result.isError === true;
          results.push({ type: "tool_result", tool_use_id: use.id, content: result.text, ...(isError && { is_error: true }) });
          yield { type: "item", item: { kind: "tool.result", toolUseId: use.id, isError, content: result.text } };
        }
      }
      // All results in one message, then the steers: the next safe point (DESIGN §9.4).
      append({ role: "user", content: [...results, ...turn.steers.splice(0).map(text)] });
    }
  }

  /**
   * Compresses the session before its next request when that's due (DESIGN §16): once the last request's prompt reached
   * `compressAt` of the model's `window`, prune, then summarize through Verdandi's `summarize` if pruning didn't bring it
   * under half that; and when the cache has gone cold (no request for the cache's TTL, or none since verdandid started),
   * only prune, which costs no cache it hasn't lost already. A compression is a transcript entry, recorded on the turn as
   * a `compression` item. One that fails writes nothing and says why in a `notice`; it's tried again past `retryAt`.
   */
  async function* compressIfDue(
    session: Session,
    input: HarnessRunInput,
    window: number,
    signal: AbortSignal,
  ): AsyncGenerator<HarnessEvent> {
    const { transcript } = session;
    const last = lastPrompt.get(transcript);
    const tokens = last?.tokens ?? estimateTokens(requestMessages(transcript.entries, true, transcript.compressions.at(-1)));
    const trigger = compressAt(window) * window;
    const due = tokens >= trigger && (!failedCompression.has(transcript) || tokens >= retryAt * window);
    const cold = last === undefined || Date.now() - last.at > cacheTtlMs;
    if (!due && !cold) return;
    const done = await compress(transcript, {
      tail: tailBudget(window),
      summarizeOver: due ? trigger / 2 : Number.POSITIVE_INFINITY,
      prune: (toolUseId, text) => {
        const folder = join(prunedDir, transcript.id);
        mkdirSync(folder, { recursive: true });
        const file = join(folder, `${toolUseId}.txt`);
        writeFileSync(file, text);
        return file;
      },
      summarize: due ? input.summarize : undefined,
    });
    if (!done) return;
    if ("error" in done) {
      failedCompression.add(transcript);
      yield {
        type: "item",
        item: {
          kind: "notice",
          text: `Verdandi couldn't compress this session (${done.error}), so it goes on as it is, and tries again at ${Math.round(retryAt * 100)}% of the context window.`,
        },
      };
      return;
    }
    // After an interrupt nothing more reaches the transcript.
    if (signal.aborted) throw new HarnessError({ message: "The turn was interrupted." });
    failedCompression.delete(transcript);
    appendCompression(transcript, done.compression);
    const { system, tools } = transcript.prefix;
    const after = estimateTokens({ system, tools, messages: requestMessages(transcript.entries, true, done.compression) });
    yield {
      type: "item",
      item: {
        kind: "compression",
        tokensBefore: tokens,
        tokensAfter: after,
        pruned: done.pruned,
        summarized: done.summarized,
        costUsd: done.costUsd,
      },
    };
  }

  /**
   * Runs `delegate_task` call `use` of `parent`'s turn (DESIGN §9.4): Verdandi routes the subtask, recorded on the turn,
   * and a child session on that route does it in one turn, starting from the parent's system prompt, with its tools
   * less `report_blocked`, and less `delegate_task` at the policy's depth. It works read-only for a profile, or while the
   * parent is held back (`ask`, or planning). Its steps carry the call's id, its requests and usage are the parent turn's,
   * and its spend counts against the task's `maxCost`, but its model calls not against `maxTurns`. Its last reply is the
   * result; a failure goes back to the parent as an error result, but an interrupt stops it with the parent.
   */
  async function* child(
    use: Anthropic.ToolUseBlock,
    parent: Session,
    input: HarnessRunInput,
    turn: Turn,
    signal: AbortSignal,
  ): AsyncGenerator<HarnessEvent, ToolResult> {
    const call = delegateArgs((typeof use.input === "object" && use.input !== null ? use.input : {}) as Record<string, unknown>);
    if ("error" in call) return { text: call.error, isError: true };
    const delegation = input.delegate;
    const depth = turn.depth + 1;
    if (!delegation || depth > delegation.maxDepth)
      return {
        text: "Delegation is off here (delegation.maxDepth in the project's routing policy): do the subtask yourself.",
        isError: true,
      };
    const routed = await delegation.route({ toolUseId: use.id, task: call.task, ...(call.profile && { profile: call.profile }) });
    if ("error" in routed) return { text: `Verdandi didn't delegate the subtask: ${routed.error}`, isError: true };
    const mode = call.profile || heldBack(turn, input.mode) ? "ask" : "build";
    const leftOut = new Set(["report_blocked", ...(depth < delegation.maxDepth ? [] : [delegateTool])]);
    const { system, tools, deferred } = parent.transcript.prefix;
    const transcript = createTranscript(options.sessionsDir, randomUUID(), {
      system,
      tools: tools.filter((t) => !leftOut.has(t.name)),
      ...(deferred && { deferred }),
    });
    // It shares its parent's MCP servers, which stop with the parent.
    const session: Session = { transcript, route: routed.route, mode, turn: undefined, mcp: parent.mcp };
    const own: Turn = {
      waiting: turn.waiting,
      steers: [],
      planning: false,
      running: turn.running,
      spent: turn.spent,
      depth,
      denials: 0,
    };
    // Its own route and mode, and the task's cost limit, but not its turn count, which counts the main agent's model calls.
    const { effort: _effort, limits, ...rest } = input;
    const childInput: HarnessRunInput = {
      ...rest,
      route: routed.route,
      mode,
      ...(limits && {
        limits: {
          taskId: limits.taskId,
          spentUsd: limits.spentUsd,
          spentTurns: 0,
          ...(limits.maxCost !== undefined && { maxCost: limits.maxCost }),
        },
      }),
    };
    const steps = loop(session, childInput, childContent(call.task, mode), own, signal);
    let end: Extract<HarnessEvent, { type: "turn.finished" }> | undefined;
    try {
      for (let step = await steps.next(); !step.done; step = await steps.next()) {
        const e = step.value;
        if (e.type === "turn.finished") end = e;
        else if (e.type === "item")
          yield e.item.kind === "assistant.message" || e.item.kind === "tool.call" || e.item.kind === "tool.result"
            ? { type: "item", item: { ...e.item, parentToolUseId: use.id } }
            : e;
        // Its text streams nowhere: the parent's reply is what the user reads as it comes.
        else if (e.type !== "text.delta" && e.type !== "model.called") yield e;
      }
    } catch (e) {
      if (signal.aborted) throw e;
      return { text: `The subagent failed: ${failure(e).message}`, isError: true };
    }
    if (end?.status !== "success") return { text: `The subagent stopped: ${end?.error ?? "it ended without finishing"}`, isError: true };
    return { text: summaryOf(transcript.entries) };
  }

  return {
    id: "native",
    run: (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (!nativeCatalog.some((e) => e.model === input.route.model))
            return yield* new HarnessError({ message: unknownModel(input.route.model) });
          const { session, events } = yield* Effect.tryPromise({
            try: () => open(input),
            catch: (e) =>
              e instanceof HarnessError
                ? e
                : new HarnessError({
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
          const turn: Turn = {
            waiting: new Map(),
            steers: [],
            planning: input.mode === "plan",
            running: new Set(),
            spent: { usd: 0 },
            depth: 0,
            denials: 0,
          };
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
                Effect.promise(() => Promise.all(turn.running)),
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
    // A session's MCP servers stop with it, by the PID captured at spawn.
    // ponytail: an idle session keeps its servers until verdandid stops; upgrade: stop them after a quiet spell and reconnect on the next turn.
    close: (threadId) =>
      Effect.promise(() => {
        const closing = threadId === undefined ? [...sessions.values()] : [sessions.get(threadId)];
        if (threadId === undefined) sessions.clear();
        else sessions.delete(threadId);
        return Promise.all(closing.map((s) => closeMcp(s?.mcp))).then(() => undefined);
      }),
  };
};
