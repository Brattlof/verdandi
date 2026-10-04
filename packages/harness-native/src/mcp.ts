import type Anthropic from "@anthropic-ai/sdk";
import type { McpServer } from "@verdandi/contracts";

/** The MCP revision Verdandi speaks; a server answers with the one it takes, and both stick to the stdio basics. */
const protocolVersion = "2025-06-18";
/** How long a server gets to start and list its tools when a session opens. */
const connectMs = 30_000;
/** How long a server gets to exit once its input closes, before its process tree is killed. */
const exitMs = 1000;
/** The longest result an MCP tool hands the agent, about 25k tokens, as Claude Code caps them. */
const maxResultChars = 100_000;
/** The Messages API's limit on a tool's name. */
const maxNameLength = 64;

const windows = process.platform === "win32";

/** A server's or tool's name as a tool name takes it, as Claude Code cleans them. */
const clean = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_");

/** The name a session's tool list gives an MCP server's tool, the same on every harness: `mcp__<server>__<tool>`. */
export const mcpToolName = (server: string, tool: string) => `mcp__${clean(server)}__${clean(tool)}`;

/** One tool as an MCP server lists it. Its name, description and schema are the server's: untrusted. */
type McpTool = { readonly name: string; readonly description?: string; readonly inputSchema?: Record<string, unknown> };

type Result = { readonly text: string; readonly isError?: boolean };

/** A running MCP server: the tools it listed when it connected, and a way to call them and to stop it. */
export type McpConnection = {
  readonly server: McpServer;
  readonly tools: readonly McpTool[];
  /** Calls `tool`; never throws: a failure is a result with `isError`. Aborting `signal` cancels the call. */
  readonly call: (tool: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<Result>;
  /** Closes its input, gives it a moment to exit, then kills its process tree by the PID captured at spawn. */
  readonly close: () => Promise<void>;
};

/**
 * Kills `pid` and what it started, by the PID captured at spawn, never by name: the process tree on Windows, its own
 * process group elsewhere. Already gone is fine.
 */
const killTree = (pid: number) => {
  if (windows) {
    Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
};

type Message = {
  readonly id?: number | string;
  readonly method?: string;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
};

/** One content item of a tool's result as the agent reads it; what it can't take yet is named and left out. */
const contentText = (item: Record<string, unknown>) => {
  if (item.type === "text") return String(item.text ?? "");
  const resource = item.resource as Record<string, unknown> | undefined;
  if (item.type === "resource" && typeof resource?.text === "string") return resource.text;
  if (item.type === "resource_link" || item.type === "resource") return `[resource ${String(item.uri ?? resource?.uri ?? "")}]`;
  return `[${String(item.type)}${item.mimeType ? ` (${String(item.mimeType)})` : ""} left out: Verdandi passes only text from MCP tools]`;
};

/** A `tools/call` result as the agent reads it, capped. */
const resultText = (result: Record<string, unknown>) => {
  const content = Array.isArray(result.content) ? (result.content as Record<string, unknown>[]) : [];
  const text =
    content.length > 0
      ? content.map(contentText).join("\n")
      : result.structuredContent !== undefined
        ? JSON.stringify(result.structuredContent)
        : "(no output)";
  return text.length > maxResultChars
    ? `${text.slice(0, maxResultChars)}\n[Cut at ${maxResultChars.toLocaleString("en-US")} characters of ${text.length.toLocaleString("en-US")}.]`
    : text;
};

/**
 * Starts `server` in `cwd` and connects to it over stdio (newline-delimited JSON-RPC): `initialize`, then every page of
 * `tools/list`. Rejects with why when it can't start, exits, or doesn't answer within `connectMs`. A server's requests
 * are refused except `ping`, and its notifications ignored: tools it adds later reach the next session (DESIGN §9.4).
 * ponytail: stdio only, without sampling, roots or elicitation; upgrade to `@modelcontextprotocol/sdk` (installed with
 * the Agent SDK, not a direct dependency) for remote servers.
 */
export const connectMcp = async (server: McpServer, cwd: string): Promise<McpConnection> => {
  const proc = Bun.spawn([server.command, ...server.args], {
    cwd,
    env: { ...server.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    // Its own process group, so stopping it reaches what it started (`npx` starts node).
    detached: !windows,
  });
  const pending = new Map<number, { readonly resolve: (m: Message) => void; readonly reject: (e: Error) => void }>();
  let exited: string | undefined;
  let nextId = 1;
  const send = (message: Record<string, unknown>) => {
    if (exited) return;
    proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    void proc.stdin.flush();
  };
  void proc.exited.then((code) => {
    exited = `it exited with code ${code}`;
    for (const p of pending.values()) p.reject(new Error(exited));
    pending.clear();
  });
  const onMessage = (message: Message) => {
    if (message.method !== undefined) {
      if (message.id === undefined) return;
      send(
        message.method === "ping"
          ? { id: message.id, result: {} }
          : { id: message.id, error: { code: -32601, message: `Verdandi doesn't offer ${message.method}.` } },
      );
      return;
    }
    const waiting = typeof message.id === "number" ? pending.get(message.id) : undefined;
    if (!waiting) return;
    pending.delete(message.id as number);
    waiting.resolve(message);
  };
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of proc.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "") continue;
        try {
          onMessage(JSON.parse(line) as Message);
        } catch {
          // Not JSON-RPC (a server logging to stdout): ignored.
        }
      }
    }
  })();
  const request = (method: string, params: Record<string, unknown>, signal?: AbortSignal) =>
    new Promise<Message>((resolve, reject) => {
      if (exited) return reject(new Error(exited));
      const id = nextId++;
      pending.set(id, { resolve, reject });
      signal?.addEventListener(
        "abort",
        () => {
          if (!pending.delete(id)) return;
          send({ method: "notifications/cancelled", params: { requestId: id, reason: "The user interrupted the turn." } });
          reject(new Error("The turn was interrupted."));
        },
        { once: true },
      );
      send({ id, method, params });
    });
  const answer = async (method: string, params: Record<string, unknown>, signal?: AbortSignal) => {
    const reply = await request(method, params, signal);
    if (reply.error) throw new Error(`it refused ${method}: ${reply.error.message ?? "no reason given"}`);
    return reply.result ?? {};
  };
  const close = async () => {
    if (!exited) {
      try {
        void proc.stdin.end();
      } catch {}
      await Promise.race([proc.exited, Bun.sleep(exitMs)]);
      if (!exited) killTree(proc.pid);
    }
    await proc.exited;
  };
  const listed = async () => {
    await answer("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "verdandi", version: "1" } });
    send({ method: "notifications/initialized" });
    const tools: McpTool[] = [];
    let cursor: unknown;
    do {
      const page = await answer("tools/list", cursor === undefined ? {} : { cursor });
      tools.push(...((Array.isArray(page.tools) ? page.tools : []) as McpTool[]).filter((t) => typeof t?.name === "string"));
      cursor = page.nextCursor;
    } while (typeof cursor === "string" && cursor !== "");
    return tools;
  };
  let timer: Timer | undefined;
  try {
    const tools = await Promise.race([
      listed(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`it didn't list its tools within ${connectMs / 1000} s`)), connectMs);
      }),
    ]);
    return {
      server,
      tools,
      close,
      call: async (tool, args, signal) => {
        try {
          const result = await answer("tools/call", { name: tool, arguments: args }, signal);
          return { text: resultText(result), ...(result.isError === true && { isError: true }) };
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          return { text: `The MCP server ${server.name} couldn't run ${tool}: ${why}.`, isError: true };
        }
      },
    };
  } catch (e) {
    await close();
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

/** A session's MCP tools, by the name its tool list gives each: the server it's on, its own name there, and whether it asks. */
export type McpTools = {
  readonly byName: ReadonlyMap<string, { readonly connection: McpConnection; readonly tool: string; readonly ask: boolean }>;
  readonly connections: readonly McpConnection[];
};

export const closeMcp = (tools: McpTools | undefined) =>
  Promise.all((tools?.connections ?? []).map((c) => c.close())).then(() => undefined);

/**
 * Connects to `servers` at once, in config order, and returns their tools and definitions for a session's tool list,
 * with a notice for each server that didn't start and each tool left out. `keep` limits it to the tools a resumed
 * session's list already has, and to the servers that have one.
 */
export const openMcp = async (
  servers: readonly McpServer[],
  cwd: string,
  keep?: ReadonlySet<string>,
): Promise<{ readonly tools: McpTools; readonly definitions: Anthropic.Tool[]; readonly notices: string[] }> => {
  const wanted = keep ? servers.filter((s) => [...keep].some((name) => name.startsWith(mcpToolName(s.name, "")))) : servers;
  const settled = await Promise.allSettled(wanted.map((s) => connectMcp(s, cwd)));
  const notices: string[] = [];
  const byName = new Map<string, { connection: McpConnection; tool: string; ask: boolean }>();
  const definitions: Anthropic.Tool[] = [];
  const connections: McpConnection[] = [];
  settled.forEach((s, i) => {
    const server = wanted[i] as McpServer;
    if (s.status === "rejected") {
      const why = s.reason instanceof Error ? s.reason.message : String(s.reason);
      notices.push(
        keep
          ? `The MCP server ${server.name} didn't start (${why}), so its tools fail in this session until it does. Fix it, then send another turn.`
          : `The MCP server ${server.name} didn't start (${why}), so this session has none of its tools. Fix it, then start a new thread to get them.`,
      );
      return;
    }
    connections.push(s.value);
    const unfit: string[] = [];
    for (const tool of s.value.tools) {
      const name = mcpToolName(server.name, tool.name);
      if (keep && !keep.has(name)) continue;
      if (name.length > maxNameLength || byName.has(name)) {
        unfit.push(tool.name);
        continue;
      }
      byName.set(name, { connection: s.value, tool: tool.name, ask: server.tools[tool.name]?.ask ?? server.ask });
      definitions.push({
        name,
        ...(typeof tool.description === "string" && tool.description !== "" && { description: tool.description }),
        input_schema: { ...tool.inputSchema, type: "object" },
      });
    }
    if (unfit.length > 0)
      notices.push(
        `This session leaves out ${unfit.join(", ")} from the MCP server ${server.name}: as mcp__<server>__<tool> the name is over ${maxNameLength} characters or clashes with another tool's. A shorter server name in the MCP config fixes it.`,
      );
  });
  return { tools: { byName, connections }, definitions, notices };
};
