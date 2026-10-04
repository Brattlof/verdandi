import { fileURLToPath } from "node:url";

/** The fake MCP server's script, to run as `bun <fakeMcpServer>` (`process.execPath` under `bun test`). */
export const fakeMcpServer = fileURLToPath(new URL("./fake-mcp-server.ts", import.meta.url));
