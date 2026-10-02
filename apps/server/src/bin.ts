#!/usr/bin/env bun
import { batch } from "./batch/batch-cli.ts";
import { chat } from "./cli/chat.ts";
import { doctor } from "./cli/doctor.ts";
import { open } from "./cli/open.ts";
import { run } from "./cli/run.ts";
import { decisions } from "./decisions/decisions-cli.ts";
import { requireBun } from "./home/bun-version.ts";
import { start } from "./main.ts";
import { routing } from "./routing/routing-cli.ts";
import { search } from "./search/search-cli.ts";
import { costs } from "./spend/costs-cli.ts";
import { trajectories } from "./tasks/trajectories-cli.ts";

const usage = `Usage:
  verdandi start [--home <dir>] [--port <n>] [--host <ip>]   run verdandid in the foreground; --host 0.0.0.0 (or this machine's LAN address) also opens it to your local network on --port, never to the internet
  verdandi open  [--home <dir>]                   open the web UI in your browser
  verdandi doctor [--home <dir>]                  check the setup: Bun, Claude Code, git, the home, the database and verdandid
  verdandi chat  [--home <dir>] [--harness <h>] [--model <m>] [--effort <e> | --auto] [--budget thrifty|balanced|max|policy] [--raise-cap] [--thread <id>]   chat with the thread for this folder, or the one named; route flags pin a route, --auto lets the router pick, --budget sets how it trades cost for strength, --raise-cap raises each reached spend cap for the rest of its period
  verdandi chat  --list [--archived] [--home <dir>]  list every thread by project; --archived includes archived ones
  verdandi chat  --archive <thread> | --unarchive <thread> [--home <dir>]   put a thread away, or bring it back
  verdandi chat  --worktree [--thread <id>] | --remove-worktree [--force]   start a new thread in a git worktree of its own (with --thread, recreate that thread's removed worktree), or remove the thread's worktree and keep its branch
  verdandi run <task> [--project <path> | --thread <id>] [--mode ask|plan|build] [--route auto|<harness>/<model>/<effort>] [--deny-requests] [--json] [--home <dir>]   send one turn headless, on a new thread in --project (default: this folder) or on the thread named, and print the agent's text; --route pins the thread to a route or with auto lets the router pick; the agent's requests stop the run unless --deny-requests denies them, and nothing is ever approved; --json prints one object at the end instead (threadId, turnId, taskId, status, route, cost, reply, error); Ctrl+C interrupts the turn. Exits 0 completed, 1 couldn't run it, 2 bad flags, 3 failed (an agent error or a failed verifier), 4 stopped at a task limit, 5 the agent asked for approval or an answer, 130 interrupted
  verdandi costs [--home <dir>] [--days <n>] [--project <path>]   cost per completed task on each route, then spend, cost by task class, usage by model, override rate and estimated savings vs always-Opus
  verdandi search <query> [--project <path>] [--home <dir>]   find past sessions' messages containing the query (3 characters or more), newest first, archived threads included
  verdandi batch <evalset.yaml> [--route auto|<harness>/<model>/<effort>]... [--dry-run] [--approve] [--timeout <minutes>] [--keep] [--home <dir>]   run an eval set's tasks on each route (default: auto, claude-code/opus/medium, claude-code/sonnet/high) in throwaway copies of their repositories, and compare success rate and cost per passed task; --dry-run only estimates, --approve allows what agents ask to do (otherwise denied)
  verdandi routing replay [--policy <file>] [--project <path>] [--home <dir>]   how saved tasks would route under a proposed policy (or each project's current one), with the estimated cost change; reads the database read-only
  verdandi trajectories export --format jsonl|routing [--project <path>] [--since <date>] [--out <file>] [--home <dir>]   saved tasks as chat conversations with tool calls (jsonl) or as what the router knew, the route and how it went (routing), one JSON line per task, secrets masked; projects listed under excludeProjects in the home's trajectories.yaml are left out; reads the database read-only
  verdandi decisions eval [--candidate <module>] [--home <dir>]   replay logged decisions through a candidate backend (a module default-exporting a decision Backend; default: today's rules) and print, per question kind, its agreement with the logged answers and, where the task's outcome is known, accuracy and Brier score; reads the database read-only`;

const commands: Record<string, (argv: readonly string[]) => Promise<void>> = {
  start,
  open,
  chat,
  run,
  doctor,
  costs,
  routing,
  decisions,
  batch,
  search,
  trajectories,
};

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
