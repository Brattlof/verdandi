import type Anthropic from "@anthropic-ai/sdk";

/**
 * How a session finds the MCP tools it defers (DESIGN §9.4): `server`, the Anthropic API's own tool search
 * (`tool_search_tool_bm25`, with `defer_loading` on the deferred tools); `bridge`, Verdandi's `tool_search`,
 * `tool_describe` and `tool_call`, for a provider without server-side search.
 */
export type ToolSearch = "server" | "bridge";

/** Deferred once a session's MCP tools number this many, or their definitions pass `deferChars` (~10K tokens), as Anthropic suggests. */
const deferTools = 10;
const deferChars = 40_000;
/** How many matches `tool_search` returns, and how much of each description. */
const maxMatches = 5;
const maxDescription = 300;
/** How many server names `tool_search`'s description lists. */
const maxServers = 20;

export const searchTool = "tool_search";
export const describeTool = "tool_describe";
export const callTool = "tool_call";

/** Whether a session defers its MCP tools: decided once, when it opens. */
export const defers = (mcp: readonly Anthropic.Tool[]) => mcp.length >= deferTools || JSON.stringify(mcp).length >= deferChars;

/** The API's search tool, which loads a deferred tool once it finds it, appending its schema without touching the cached prefix. */
export const serverSearch: Anthropic.ToolSearchToolBm25_20251119 = {
  type: "tool_search_tool_bm25_20251119",
  name: "tool_search_tool_bm25",
};

/**
 * The bridge's tools. The directory in `tool_search`'s description is the configured server names, sorted and capped,
 * which come from the user's config; the servers' own tool names and descriptions are untrusted and reach the agent
 * only as search results.
 */
export const bridgeTools = (deferred: readonly Anthropic.Tool[]): Anthropic.Tool[] => {
  const servers = [...new Set(deferred.map((t) => t.name.split("__")[1] ?? ""))].filter(Boolean).sort();
  const listed = servers.slice(0, maxServers).join(", ") + (servers.length > maxServers ? `, and ${servers.length - maxServers} more` : "");
  return [
    {
      name: searchTool,
      description: `Finds tools of the user's MCP servers (${listed}) that aren't loaded, by what they do. Returns the best matches' names and descriptions. Read one's parameters with ${describeTool}, then run it with ${callTool}.`,
      input_schema: {
        type: "object",
        properties: { query: { type: "string", description: "What the tool should do, in a few words." } },
        required: ["query"],
      },
    },
    {
      name: describeTool,
      description: `Shows the parameters of a tool ${searchTool} found, as a JSON schema.`,
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "The tool's name, as mcp__<server>__<tool>." } },
        required: ["name"],
      },
    },
    {
      name: callTool,
      description: `Runs a tool ${searchTool} found, with its arguments as ${describeTool} describes them. It asks the user first when the tool does.`,
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The tool's name, as mcp__<server>__<tool>." },
          arguments: { type: "object", description: "The tool's arguments." },
        },
        required: ["name"],
      },
    },
  ];
};

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

/**
 * The deferred tools that best match `query`, as the agent reads them: each one's name and the start of its description.
 * ponytail: ranks by how many of the query's words a tool's name and description hold; upgrade to BM25 if that misses.
 */
export const searchDeferred = (deferred: readonly Anthropic.Tool[], query: string) => {
  const wanted = words(query);
  const ranked = deferred
    .map((tool) => {
      const has = words(`${tool.name.replaceAll("_", " ")} ${tool.description ?? ""}`);
      return { tool, score: [...wanted].filter((w) => has.has(w)).length };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxMatches);
  if (ranked.length === 0) return `No tool matches "${query}". Try other words.`;
  return ranked
    .map(({ tool }) => {
      const description = tool.description ?? "";
      return `- ${tool.name}: ${description.length > maxDescription ? `${description.slice(0, maxDescription)}…` : description}`;
    })
    .join("\n");
};

/**
 * A `tool_call` as the real tool it runs, with the arguments it was given, so approvals, items and trajectories see
 * the real name. Anything else, or a call naming a tool that isn't deferred, comes back as it was.
 */
export const unwrapCall = <T extends Anthropic.ToolUseBlockParam>(use: T, deferred: readonly Anthropic.Tool[] | undefined): T => {
  if (use.name !== callTool || !deferred) return use;
  const args = (typeof use.input === "object" && use.input !== null ? use.input : {}) as Record<string, unknown>;
  if (typeof args.name !== "string" || !deferred.some((t) => t.name === args.name)) return use;
  const input = typeof args.arguments === "object" && args.arguments !== null ? args.arguments : {};
  return { ...use, name: args.name, input };
};
