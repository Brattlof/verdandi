#!/usr/bin/env bun
import { chat } from "./cli/chat.ts";
import { requireBun } from "./config/bun-version.ts";
import { start } from "./main.ts";

const usage = `Usage:
  goldiloop start [--home <dir>] [--port <n>]      run goldiloopd in the foreground
  goldiloop chat  [--home <dir>] [--model <m>] [--effort <e>]   chat with the thread for this folder`;

const commands: Record<string, (argv: readonly string[]) => Promise<void>> = { start, chat };

const [name, ...argv] = Bun.argv.slice(2);
const command = name === undefined ? undefined : commands[name];
if (!command) {
  console.error(usage);
  process.exit(1);
}
try {
  requireBun(Bun.version);
  await command(argv);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
