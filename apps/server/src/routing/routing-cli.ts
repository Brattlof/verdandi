import { basename } from "node:path";
import { clip, describeRouteChange, type Route } from "@verdandi/contracts";
import { Effect } from "effect";
import { projectIdFor } from "../event-store/decider.ts";
import { flag, resolveHome } from "../home/home.ts";
import { resolveProjectPath } from "../projects/project.ts";
import { loadSavedTasks, type Replay, replay, sameRoute } from "./replay.ts";

const usd = (n: number) => `$${n.toFixed(4)}`;
const signed = (n: number) => `${n < 0 ? "-" : "+"}${usd(Math.abs(n))}`;
const describe = (r: Route) => `${r.harness} ${r.model} ${r.effort}`;
const line = (text: string) => clip(text.trim().split(/\r?\n/, 1)[0] ?? "", 60);

/** A replay as text: what would route differently and to what, the estimated cost change, and what was assumed. */
export const replayText = (r: Replay) => {
  if (r.tasks.length === 0 && r.failed.length === 0) return "No saved tasks to replay yet.\n";
  const pinned = r.tasks.filter((t) => (t.task.inputs?.pinned ?? t.task.pinnedBefore) === true).length;
  const changed = r.tasks.filter((t) => !sameRoute(t.task.route, t.to));
  const out = [
    `Replayed ${r.tasks.length + r.failed.length} tasks under ${r.policy}${pinned ? ` (${pinned} pinned: a pin always wins)` : ""}.\n`,
    changed.length === 0 ? "None would route differently.\n" : `${changed.length} would route differently:\n`,
  ];
  for (const t of changed) {
    const was = t.task.taskClass && t.task.taskClass !== t.taskClass ? `${t.task.taskClass} → ${t.taskClass}` : t.taskClass;
    const cost = t.costFrom !== null && t.costTo !== null ? `, est. ${usd(t.costFrom)} → ${usd(t.costTo)}` : "";
    out.push(
      `  ${t.task.taskId.slice(0, 8)}  ${basename(t.task.projectPath)}  "${line(t.task.text)}"\n`,
      `    ${was}: ${describe(t.task.route)} → ${describe(t.to)} (${describeRouteChange(t.task.route, t.to)}${cost})\n`,
      `    ${t.reason}\n`,
    );
  }
  const priced = changed.filter((t) => t.costFrom !== null && t.costTo !== null);
  if (priced.length > 0) {
    const delta = priced.reduce((sum, t) => sum + (t.costTo ?? 0) - (t.costFrom ?? 0), 0);
    const unpriced = changed.length - priced.length;
    out.push(
      `Estimated cost change: ${signed(delta)} over ${priced.length} changed task${priced.length === 1 ? "" : "s"}. ` +
        "An estimate: each task's recorded tokens priced at its targets' catalog list prices; an effort change isn't priced, and no model was called." +
        (unpriced ? ` ${unpriced} changed task${unpriced === 1 ? " has" : "s have"} a target the catalog doesn't price.` : "") +
        "\n",
    );
  }
  for (const f of r.failed) out.push(`  ${f.task.taskId.slice(0, 8)} can't be routed under this policy: ${f.message}\n`);
  if (r.assumed) out.push(`Tasks recorded before their routing inputs were kept were replayed assuming ${r.assumed}.\n`);
  return out.join("");
};

/** `verdandi routing replay`: how saved tasks would route under the current or a proposed policy. Reads the database read-only. */
export const routing = async (argv: readonly string[]) => {
  if (argv[0] !== "replay") throw new Error("Usage: verdandi routing replay [--policy <file>] [--project <path>] [--home <dir>]");
  const home = resolveHome(argv);
  const project = flag(argv, "--project");
  const projectId = project === undefined ? undefined : projectIdFor(await Effect.runPromise(resolveProjectPath(project)));
  process.stdout.write(replayText(replay(loadSavedTasks(home, projectId), flag(argv, "--policy"))));
};
