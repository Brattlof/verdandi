import type { RouteCost } from "@verdandi/contracts";
import { Effect } from "effect";
import { readServerFile, resolveHome } from "../config/home.ts";
import { connect } from "../rpc/client.ts";

const usd = (n: number | null) => (n === null ? "-" : `$${n.toFixed(4)}`);

/** One line per route, in aligned columns. */
export const costTable = (rows: readonly RouteCost[]) => {
  if (rows.length === 0) return "No task outcomes yet. A task's outcome is recorded when its turns finish.\n";
  const lines = [
    ["route", "tasks", "completed", "cost", "per completed"],
    ...rows.map((r) => [
      `${r.route.harness} ${r.route.model} ${r.route.effort}`,
      String(r.tasks),
      String(r.completed),
      usd(r.costUsd),
      usd(r.costPerCompletedUsd),
    ]),
  ];
  const widths = lines[0]?.map((_, i) => Math.max(...lines.map((l) => l[i]?.length ?? 0))) ?? [];
  return lines
    .map(
      (l) =>
        `${l
          .map((cell, i) => cell.padEnd(widths[i] ?? 0))
          .join("  ")
          .trimEnd()}\n`,
    )
    .join("");
};

/** `verdandi costs`: cost per completed task on each route. A failed task's cost counts against its route. */
export const costs = async (argv: readonly string[]) => {
  const server = readServerFile(resolveHome(argv));
  const rows = await Effect.runPromise(Effect.scoped(Effect.flatMap(connect(server), (client) => client.TaskCostsList())));
  process.stdout.write(costTable(rows));
};
