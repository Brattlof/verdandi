import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Backend } from "@verdandi/decisions";
import { Effect } from "effect";
import { flag, resolveHome } from "../home/home.ts";
import { verdandiRules } from "../routing/routing.ts";
import { evaluate, type KindReport, loadLoggedDecisions } from "./decisions-eval.ts";

const pct = (n: number | null) => (n === null ? "-" : `${Math.round(n * 100)}%`);
const num = (n: number | null) => (n === null ? "-" : n.toFixed(3));

/** A report as text: aggregates only, never a decision's text. */
export const evalText = (reports: readonly KindReport[]) => {
  if (reports.length === 0) return "No logged decisions yet.\n";
  const out: string[] = [];
  for (const r of reports) {
    out.push(`\n${r.kind}: ${r.decisions} decisions, ${r.known} with a known outcome (${pct(r.good)} went well)\n`);
    const rows = [
      ["backend", "answered", "agrees", "low conf", "accuracy", "Brier", "mean P(well)"],
      ...r.backends.map((b) => [
        b.id,
        String(b.answered),
        pct(b.agreement),
        pct(b.lowConfidence),
        pct(b.accuracy),
        num(b.brier),
        num(b.meanChance),
      ]),
    ];
    const widths = rows[0]?.map((_, i) => Math.max(...rows.map((row) => row[i]?.length ?? 0))) ?? [];
    for (const row of rows)
      out.push(
        `  ${row
          .map((c, i) => c.padEnd(widths[i] ?? 0))
          .join("  ")
          .trimEnd()}\n`,
      );
  }
  out.push(
    "\nAgrees: same answer as logged (a score within 0.1, a yes/no on the same side). A task went well when its last turn completed with no override, escalation or thumbs down.\n" +
      "P(well) reads a class's confidence, 1 - difficulty, and 1 - P(correcting) as the chance the task went well; accuracy and Brier score that chance against the outcome.\n",
  );
  return out.join("");
};

const loadCandidate = async (file: string | undefined): Promise<Backend> => {
  if (file === undefined) return verdandiRules;
  const backend: Partial<Backend> | undefined = await (await import(pathToFileURL(resolve(file)).href)).default;
  if (typeof backend?.id !== "string" || typeof backend.answer !== "function")
    throw new Error(
      `${file} must default-export a decision backend ({ id, answer }, the \`Backend\` type of @verdandi/decisions) or a promise of one.`,
    );
  return backend as Backend;
};

/** `verdandi decisions eval`: logged decisions replayed through a candidate backend (default: today's rules), scored per kind. Reads the database read-only. */
export const decisions = async (argv: readonly string[]) => {
  if (argv[0] !== "eval") throw new Error("Usage: verdandi decisions eval [--candidate <module>] [--home <dir>]");
  const logged = loadLoggedDecisions(resolveHome(argv));
  const candidate = await loadCandidate(flag(argv, "--candidate"));
  process.stdout.write(evalText(await Effect.runPromise(evaluate(logged, candidate))));
};
