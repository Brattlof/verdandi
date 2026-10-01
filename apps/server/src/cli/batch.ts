import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BatchReport, HarnessAdapter, HarnessId } from "@verdandi/contracts";
import { findClaude, makeClaudeCodeAdapter } from "@verdandi/harness-claude-code";
import { makeFakeHarness } from "@verdandi/testkit";
import { defaultBatchRoutes, estimateBatch, loadEvalSet, parseBatchRoute, runBatch, summarize } from "../batch/batch.ts";
import { flag, resolveHome } from "../config/home.ts";
import { columns } from "./costs.ts";

const usd = (n: number | null) => (n === null ? "-" : `$${n.toFixed(4)}`);

/** Every value of a flag that may repeat, e.g. `--route auto --route claude-code/opus/medium`. */
const flags = (argv: readonly string[], name: string) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1] as string] : []));

/**
 * `verdandi batch <evalset.yaml>`: runs each task of an eval set on each route in a throwaway copy of its repository,
 * grades it with its verifier, and prints success rate and cost per passed task by route (DESIGN §8.10). The run has
 * its own home under the profile's `batch/`, so its threads stay out of yours; `--dry-run` only estimates.
 */
export const batch = async (argv: readonly string[]) => {
  const file = argv[0];
  if (!file || file.startsWith("--")) throw new Error("verdandi batch needs an eval set file, e.g. verdandi batch evals/m2.yaml");
  const tasks = loadEvalSet(resolve(file));
  const routes = flags(argv, "--route");
  const chosen = routes.length > 0 ? routes : defaultBatchRoutes;
  chosen.forEach(parseBatchRoute); // fails loudly before anything runs
  const home = resolveHome(argv);
  const fake = argv.includes("--dev-fake-harness");
  const claudePath = fake ? undefined : findClaude();
  if (!fake && !claudePath) throw new Error("Claude Code CLI not found on PATH. Install it and run `claude` once to log in.");
  const runHome = join(home, "batch", new Date().toISOString().replaceAll(":", "-"));
  const harnesses: Partial<Record<HarnessId, HarnessAdapter>> = fake
    ? { fake: makeFakeHarness() }
    : {
        "claude-code": makeClaudeCodeAdapter({ claudePath: claudePath ?? "claude", additionalDirectories: [join(runHome, "attachments")] }),
      };

  const estimate = await estimateBatch(tasks, chosen, harnesses);
  const total = estimate.reduce((sum, r) => sum + (r.usd ?? 0), 0);
  process.stdout.write(
    columns([
      ["task", "route", "runs on", "~tokens", "~cost"],
      ...estimate.map((r) => [r.task, r.route, r.ran ? `${r.ran.model} ${r.ran.effort}` : (r.error ?? "-"), String(r.tokens), usd(r.usd)]),
    ]),
  );
  process.stdout.write(
    `${tasks.length} tasks × ${chosen.length} routes, roughly ${usd(total)} at list prices: a guess from each task class's typical size. Subscription routes spend quota instead.\n`,
  );
  if (argv.includes("--dry-run")) return;

  const minutes = Number(flag(argv, "--timeout") ?? 30);
  if (!(minutes > 0)) throw new Error("--timeout takes the minutes a task may run, e.g. --timeout 30");
  const startedAt = new Date().toISOString();
  const { results, stopped } = await runBatch({
    tasks,
    routes: chosen,
    home,
    runHome,
    harnesses,
    approve: argv.includes("--approve"),
    taskTimeoutMs: minutes * 60_000,
    keep: argv.includes("--keep"),
    onResult: (r) =>
      process.stdout.write(
        `${r.passed ? "pass" : "FAIL"}  ${r.task} on ${r.route}${r.ran ? ` (${r.ran.model} ${r.ran.effort})` : ""}: ${usd(r.costUsd)}, ${r.turns} turns, ${r.escalations} escalations, ${(r.wallMs / 1000).toFixed(0)}s${r.error ? ` — ${r.error}` : ""}\n`,
      ),
  });
  const report: BatchReport = { v: 1, evalSet: resolve(file), startedAt, results };
  writeFileSync(join(runHome, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(
    `\n${columns([
      ["route", "tasks", "passed", "success", "cost", "per passed", "mean time", "escalations"],
      ...summarize(results).map((s) => [
        s.route,
        String(s.tasks),
        String(s.passed),
        `${Math.round((s.passed / s.tasks) * 100)}%`,
        usd(s.costUsd),
        usd(s.costPerPassedUsd),
        `${(s.meanWallMs / 1000).toFixed(0)}s`,
        String(s.escalations),
      ]),
    ])}`,
  );
  process.stdout.write(`\nReport: ${join(runHome, "report.json")}. Browse the run's threads with: verdandi start --home "${runHome}"\n`);
  if (stopped) throw new Error(`Stopped early: ${stopped}`);
};
