#!/usr/bin/env bun
import { chat } from "./cli/chat.ts";
import { costs } from "./cli/costs.ts";
import { doctor } from "./cli/doctor.ts";
import { open } from "./cli/open.ts";
import { requireBun } from "./config/bun-version.ts";
import { start } from "./main.ts";

const usage = `Usage:
  verdandi start [--home <dir>] [--port <n>]      run verdandid in the foreground
  verdandi open  [--home <dir>]                   open the web UI in your browser
  verdandi doctor [--home <dir>]                  check the setup: Bun, Claude Code, git, the home, the database and verdandid
  verdandi chat  [--home <dir>] [--model <m>] [--effort <e>] [--thread <id>]   chat with the thread for this folder, or the one named
  verdandi chat  --list [--home <dir>]              list every thread by project
  verdandi costs [--home <dir>]                   cost per completed task on each route`;

const commands: Record<string, (argv: readonly string[]) => Promise<void>> = { start, open, chat, doctor, costs };

const [name, ...argv] = Bun.argv.slice(2);
const command = name === undefined ? undefined : commands[name];
if (!command) {
  console.error(usage);
  process.exit(1);
}
try {
  if (name !== "doctor") requireBun(Bun.version); // doctor reports an old Bun as one of its checks
  await command(argv);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
