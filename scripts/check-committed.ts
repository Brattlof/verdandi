// Fails when a tracked file holds a token-shaped secret or is a file that must stay local.
//   bun scripts/check-committed.ts
// Prints the file, line and kind of each hit, never the match itself. Test fixtures that need a
// key-shaped string build it from parts at runtime ("sk-ant-" + "api03-…"), so the source holds none.
import { join } from "node:path";
import { tokenPatterns } from "../packages/trajectories/src/redact.ts";

/** Tracked paths that are local state or scratch work (AGENTS.md), with why each must stay out. */
const localOnly: readonly [RegExp, string][] = [
  [/(^|\/)\.plans\//, "plans and specs stay local"],
  [/(^|\/)spikes\//, "spike code stays local"],
  [/(^|\/)evals\/compression\/private\//, "the compression exam's real sessions stay local"],
  [/(^|\/)\.verdandi-[^/]*\//, "a dev server's state folder"],
  [/(^|\/)server\.json$/, "holds a profile's token"],
  [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, "holds secrets"],
  [/\.db(-wal|-shm)?$/, "a database"],
];

export type Finding = { path: string; line?: number; why: string };

/** Pure: what's wrong with one tracked file, given its path and text (undefined for a binary file). */
export const checkFile = (path: string, text: string | undefined): Finding[] => {
  const local = localOnly.find(([pattern]) => pattern.test(path));
  if (local) return [{ path, why: `tracked, but ${local[1]}: git rm --cached it` }];
  if (text === undefined) return [];
  return tokenPatterns.flatMap(([pattern, kind]) =>
    [...text.matchAll(pattern)].map((m) => ({
      path,
      line: text.slice(0, m.index).split("\n").length,
      why: `looks like a ${kind}: remove it, or build a test fixture from parts at runtime`,
    })),
  );
};

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  const paths = listed.stdout.toString().split("\0").filter(Boolean);
  const findings: Finding[] = [];
  for (const path of paths) {
    const file = Bun.file(join(root, path));
    // A tracked symlink to a folder (the agent skill links) has no text to scan.
    const bytes = await file.bytes().catch(() => undefined);
    const text = bytes && !bytes.includes(0) ? new TextDecoder().decode(bytes) : undefined;
    findings.push(...checkFile(path, text));
  }
  for (const f of findings) console.error(`${f.path}${f.line ? `:${f.line}` : ""}: ${f.why}`);
  console.log(`Checked ${paths.length} tracked files: ${findings.length} problem(s).`);
  if (findings.length > 0) process.exit(1);
}
