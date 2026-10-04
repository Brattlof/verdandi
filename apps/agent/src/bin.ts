#!/usr/bin/env bun
import { batch } from "./batch/batch-cli.ts";
import { chat } from "./cli/chat.ts";
import { doctor } from "./cli/doctor.ts";
import { run } from "./cli/run.ts";
import { web } from "./cli/web.ts";
import { decisions } from "./decisions/decisions-cli.ts";
import { devices } from "./devices/devices-cli.ts";
import { gateway } from "./gateway/gateway-cli.ts";
import { gc } from "./gc/gc-cli.ts";
import { requireBun } from "./home/bun-version.ts";
import { start } from "./main.ts";
import { key } from "./native/key-cli.ts";
import { routing } from "./routing/routing-cli.ts";
import { schedule } from "./schedule/schedule-cli.ts";
import { search } from "./search/search-cli.ts";
import { skills } from "./skills/skills-cli.ts";
import { costs } from "./spend/costs-cli.ts";
import { trajectories } from "./tasks/trajectories-cli.ts";

const usage = `Usage:
  verdandi [chat flags]                           chat in the terminal UI: on the current folder when it's a project (inside a git repo, or one you've chatted in), else in the profile's workspace; --here or --workspace picks one; --plain (or a pipe) gets the line chat instead. Runs verdandid in this process while you chat unless one is running already
  verdandi start [--home <dir>] [--port <n>]      keep verdandid running in the foreground, for the web UI and, later, the scheduler and gateway; it listens only on 127.0.0.1 and serves no web page
  verdandi web   [--home <dir>] [--port <n>] [--host <ip>] [--no-open]   serve the web UI until Ctrl+C and open it in your browser, relaying to the running verdandid or one it runs meanwhile; --host 0.0.0.0 (or this machine's LAN or Tailscale address) also opens it to your local network or tailnet on --port, never to the internet
  verdandi doctor [--home <dir>]                  check the setup: Bun, Claude Code, git, the home, the database, what the next cleanup sweep removes, and verdandid
  verdandi devices list | approve <request> | deny <request> | revoke <device> [--home <dir>]   list the paired devices and the pairing requests waiting (each with the code its device shows), approve or deny a request, or revoke a device so its token stops working and its connections close; through the running verdandid
  verdandi gateway senders | senders revoke <platform> <sender> | pair <code> [--owner] | deny <request> | owner <platform> <sender> [--home <dir>]   who may reach Verdandi from chat apps: list the senders with access and those waiting to pair; let one in with the code they got in their DM (--owner also makes them the platform's owner, who alone approves requests and runs owner-only commands there), deny one, revoke a sender, or name the owner; through the running verdandid
  verdandi gc [--dry-run] [--home <dir>]          run the cleanup policy in gc.yaml now: remove old checkpoints and the worktrees of threads archived long ago (never one with uncommitted changes); --dry-run only lists them
  verdandi chat  [--home <dir>] [--here | --workspace] [--harness <h>] [--model <m>] [--effort <e> | --auto] [--budget thrifty|balanced|max|policy] [--raise-cap] [--thread <id>] [--plain]   the same as bare verdandi: chat with the thread for this folder (or the workspace), or the one named; route flags pin a route, --auto lets the router pick, --budget sets how it trades cost for strength, --raise-cap raises each reached spend cap for the rest of its period
  verdandi chat  --list [--archived] [--home <dir>]  list every thread by project; --archived includes archived ones
  verdandi chat  --archive <thread> | --unarchive <thread> [--home <dir>]   put a thread away, or bring it back
  verdandi chat  --worktree [--thread <id>] | --remove-worktree [--force]   start a new thread in a git worktree of its own (with --thread, recreate that thread's removed worktree), or remove the thread's worktree and keep its branch
  verdandi run <task> [--project <path> | --here | --workspace | --thread <id>] [--worktree] [--mode ask|plan|build] [--route auto|<harness>/<model>/<effort>] [--deny-requests] [--json] [--home <dir>]   send one turn headless, on a new thread in --project (default: this folder when it's a project, else the workspace), in a git worktree of its own with --worktree (never the workspace's), or on the thread named, running verdandid for the run unless one is running, and print the agent's text, following the turns Verdandi sends when it escalates the task; --route pins the thread to a route or with auto lets the router pick; the agent's requests stop the run unless --deny-requests denies them, and nothing is ever approved; --json prints one object at the end instead (threadId, turnId, taskId, status, route, cost, reply, escalations, error); Ctrl+C interrupts the turn. Exits 0 completed, 1 couldn't run it, 2 bad flags, 3 failed (an agent error, or a failed verifier the task didn't escalate past), 4 stopped at a task limit, 5 the agent asked for approval or an answer, 130 interrupted
  verdandi schedule add <name> <task> --cron <expression> [--project <path> | --here | --workspace] [--worktree | --no-worktree] [--mode ask|plan|build] [--route auto|<harness>/<model>/<effort>] [--home <dir>]   have the OS scheduler (crontab, launchd or Task Scheduler) run the task on the cron expression, in local time, as verdandi run --deny-requests --json on a new thread in the folder named, or else the one verdandi run would pick here; in a project's git repo each run gets a worktree of its own unless --no-worktree. Every request is denied; spend caps and task limits apply
  verdandi schedule list | remove <name> [--home <dir>]   list the jobs with their next run and how the last one went (status, exit code, cost, thread), or unregister one and delete its files and log
  verdandi costs [--home <dir>] [--days <n>] [--project <path>]   cost per completed task on each route, then spend, cost by task class, usage by model, override rate and estimated savings vs always-Opus
  verdandi search <query> [--project <path>] [--home <dir>]   find past sessions' messages containing the query (3 characters or more), newest first, archived threads included
  verdandi skills list | history <name> | revert <name> <n> | pin <name> | unpin <name> | restore <name> [--home <dir>]   list the profile's skills (which the agent proposes with skill_manage and you approve; those Verdandi created show stale after 14 days unused), the ones archived after 30 or deleted (kept, not loaded), and those in the read-only extra folders of skills.yaml; history lists the changes written to a skill, newest first, and revert puts change n's file back; pin stops agents changing a skill and Verdandi archiving it, unpin undoes that; restore brings an archived skill back; all but list go through the running verdandid
  verdandi batch <evalset.yaml> [--route auto|<harness>/<model>/<effort>]... [--dry-run] [--approve] [--timeout <minutes>] [--keep] [--home <dir>]   run an eval set's tasks on each route (default: auto, claude-code/opus/medium, claude-code/sonnet/high) in throwaway copies of their repositories, and compare success rate and cost per passed task; --dry-run only estimates, --approve allows what agents ask to do (otherwise denied)
  verdandi key set anthropic | key delete anthropic   store the native harness's Anthropic API key in the OS keychain (read without echo, or piped in), or remove it; restart verdandid after. VERDANDI_ANTHROPIC_API_KEY in the environment or .env wins over it
  verdandi routing replay [--policy <file>] [--project <path>] [--home <dir>]   how saved tasks would route under a proposed policy (or each project's current one), with the estimated cost change; reads the database read-only
  verdandi trajectories export --format jsonl|routing [--project <path>] [--since <date>] [--out <file>] [--home <dir>]   saved tasks as chat conversations with tool calls (jsonl) or as what the router knew, the route and how it went (routing), one JSON line per task, secrets masked; projects listed under excludeProjects in the home's trajectories.yaml are left out; reads the database read-only
  verdandi decisions eval [--candidate <module>] [--home <dir>]   replay logged decisions through a candidate backend (a module default-exporting a decision Backend; default: today's rules) and print, per question kind, its agreement with the logged answers and, where the task's outcome is known, accuracy and Brier score; reads the database read-only`;

const commands: Record<string, (argv: readonly string[]) => Promise<void>> = {
  start,
  web,
  chat,
  run,
  doctor,
  costs,
  routing,
  decisions,
  batch,
  search,
  trajectories,
  gc,
  devices,
  gateway,
  skills,
  key,
  schedule,
};

const args = Bun.argv.slice(2);
if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
  console.log(usage);
  process.exit(0);
}
// Bare `verdandi`, or flags alone, is the terminal chat.
const [name, ...argv] = args[0] === undefined || args[0].startsWith("--") ? ["chat", ...args] : args;
const command = commands[name ?? ""];
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
