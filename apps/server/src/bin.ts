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
  verdandi chat  [--home <dir>] [--harness <h>] [--model <m>] [--effort <e> | --auto] [--budget thrifty|balanced|max|policy] [--raise-cap] [--thread <id>]   chat with the thread for this folder, or the one named; route flags pin a route, --auto lets the router pick, --budget sets how it trades cost for strength, --raise-cap raises each reached spend cap for the rest of its period
  verdandi chat  --list [--archived] [--home <dir>]  list every thread by project; --archived includes archived ones
  verdandi chat  --archive <thread> | --unarchive <thread> [--home <dir>]   put a thread away, or bring it back
  verdandi costs [--home <dir>] [--days <n>] [--project <path>]   cost per completed task on each route, then spend, cost by task class, usage by model, override rate and estimated savings vs always-Opus`;

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
