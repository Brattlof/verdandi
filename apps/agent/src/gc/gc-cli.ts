import type { GcReport } from "@verdandi/contracts";
import { Effect } from "effect";
import { readServerFile, resolveHome } from "../home/home.ts";
import { connect } from "../rpc/client.ts";

/** One line per thread whose refs went and per worktree, then a total. */
export const gcText = (r: GcReport) => {
  const verb = r.dryRun ? "Would remove" : "Removed";
  const refs = r.removed.reduce((sum, t) => sum + t.refs.length, 0);
  const lines = [
    ...r.removed.map((t) => `${verb} ${t.refs.length} checkpoint refs of thread ${t.threadId}`),
    ...r.worktrees.map((w) =>
      w.kept
        ? `Kept the worktree of thread ${w.threadId} at ${w.root}: ${w.kept}`
        : `${verb} the worktree of thread ${w.threadId} at ${w.root}`,
    ),
    `${verb} ${refs} of ${r.refs} checkpoint refs and ${r.worktrees.filter((w) => !w.kept).length} worktrees.`,
  ];
  return `${lines.join("\n")}\n`;
};

/** `verdandi gc [--dry-run]`: runs the cleanup policy now, in the running verdandid, so what it removes is recorded. */
export const gc = async (argv: readonly string[]) => {
  const server = readServerFile(resolveHome(argv));
  const report = await Effect.runPromise(
    Effect.scoped(Effect.flatMap(connect(server), (client) => client.Gc({ dryRun: argv.includes("--dry-run") }))),
  );
  process.stdout.write(gcText(report));
};
