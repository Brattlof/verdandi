/** Lints a project: `index.html` as the root, and every `.html` under `compositions/` as a sub-composition. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseFile } from "./parse.ts";
import { type Finding, lintFile } from "./rules.ts";

export type LintResult = {
  readonly ok: boolean;
  readonly errors: number;
  readonly warnings: number;
  readonly findings: readonly Finding[];
  readonly files: readonly string[];
};

export const summarize = (findings: readonly Finding[], files: readonly string[]): LintResult => {
  const errors = findings.filter((f) => f.severity === "error").length;
  return { ok: errors === 0, errors, warnings: findings.filter((f) => f.severity === "warning").length, findings, files };
};

export const lintProject = async (projectDir: string, entry = "index.html"): Promise<LintResult> => {
  const root = resolve(projectDir);
  if (!existsSync(join(root, entry)))
    throw new Error(`${join(root, entry)} doesn't exist. Run verdandi video lint in a project folder (made with verdandi video init).`);
  // Forward slashes on every OS, so findings name files the same way everywhere.
  const subs = [...new Bun.Glob("compositions/**/*.html").scanSync({ cwd: root })].map((f) => f.replaceAll("\\", "/")).sort();
  const files = [entry, ...subs];
  const findings: Finding[] = [];
  const parsedFiles = await Promise.all(
    files.map(async (file) => [file, await parseFile(readFileSync(join(root, file), "utf8"))] as const),
  );
  // A data-start reference may name a clip in any file of the project.
  const ids = new Set(
    parsedFiles.flatMap(([, p]) =>
      p.tags.flatMap((t) => [t.attrs.get("id"), t.attrs.get("data-composition-id")].filter((v) => v !== undefined)),
    ),
  );
  for (const [file, parsed] of parsedFiles) {
    const abs = join(root, file);
    findings.push(
      ...lintFile({
        file,
        parsed,
        isRoot: file === entry,
        ids,
        exists: (rel) => {
          const clean = decodeURIComponent(rel.split(/[?#]/)[0] ?? "");
          const target = clean.startsWith("/") ? join(root, clean) : resolve(dirname(abs), clean);
          return !relative(root, target).startsWith("..") && existsSync(target);
        },
      }),
    );
  }
  return summarize(findings, files);
};

const icon = { error: "✗", warning: "⚠", info: "ℹ" } as const;

/** Findings as lines a person reads: `✗ file:line code: message`, then `  Fix: …`. */
export const findingsText = (r: LintResult, verbose = false) => {
  const shown = r.findings.filter((f) => verbose || f.severity !== "info");
  const lines = shown.flatMap((f) => [
    `${icon[f.severity]} ${f.file}${f.line ? `:${f.line}` : ""} ${f.code}: ${f.message}`,
    ...(f.fix ? [`  Fix: ${f.fix}`] : []),
  ]);
  lines.push(
    r.findings.length
      ? `${r.errors} error${r.errors === 1 ? "" : "s"}, ${r.warnings} warning${r.warnings === 1 ? "" : "s"} in ${r.files.length} file${r.files.length === 1 ? "" : "s"}.`
      : `No problems in ${r.files.length} file${r.files.length === 1 ? "" : "s"}.`,
  );
  return `${lines.join("\n")}\n`;
};
