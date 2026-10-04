/**
 * A fake MCP server for tests, speaking MCP over stdio (newline-delimited JSON-RPC) like a real one: run it as
 * `bun <fakeMcpServer>`. Its tools: `echo` (`text`, answered as `echo: <text>`), `pid` (its process id, so a test can
 * check it stopped), `fail` (an error result), and `FAKE_MCP_TOOLS` more (`tool_1`, …). It lists them 50 to a page.
 */
import { createInterface } from "node:readline";

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };
const text = { type: "object", properties: { text: { type: "string", description: "Any text." } }, required: ["text"] };
const none = { type: "object", properties: {} };
const tools: Tool[] = [
  { name: "echo", description: "Answers with the text it gets.", inputSchema: text },
  { name: "pid", description: "Answers with the server's process id.", inputSchema: none },
  { name: "fail", description: "Always fails.", inputSchema: none },
  ...Array.from({ length: Number(process.env.FAKE_MCP_TOOLS ?? 0) }, (_, i) => ({
    name: `tool_${i + 1}`,
    description: `Fake tool number ${i + 1}, which answers with its own name.`,
    inputSchema: text,
  })),
];
const page = 50;

const send = (message: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const content = (s: string) => ({ content: [{ type: "text", text: s }] });

const call = (name: string, args: Record<string, unknown>) => {
  if (name === "echo") return content(`echo: ${String(args.text)}`);
  if (name === "pid") return content(String(process.pid));
  if (name === "fail") return { ...content("The fake tool failed."), isError: true };
  if (tools.some((t) => t.name === name)) return content(name);
  return { ...content(`No tool named ${name}.`), isError: true };
};

const answer = (method: string, params: Record<string, unknown>) => {
  if (method === "initialize")
    return { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
  if (method === "tools/list") {
    const from = Number(params.cursor ?? 0);
    const next = from + page;
    return { tools: tools.slice(from, next), ...(next < tools.length && { nextCursor: String(next) }) };
  }
  if (method === "tools/call") return call(String(params.name), (params.arguments ?? {}) as Record<string, unknown>);
  return undefined;
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
  if (message.id === undefined) return;
  const result = answer(message.method, message.params ?? {});
  send(result ? { id: message.id, result } : { id: message.id, error: { code: -32601, message: `No method ${message.method}.` } });
});
