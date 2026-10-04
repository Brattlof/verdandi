// Enforces the commit message rule in AGENTS.md: one line, after Google's CL descriptions, no body.
//   bun scripts/git-hooks.ts install           point git at scripts/git-hooks (`bun install` runs this)
//   bun scripts/git-hooks.ts commit-msg <file> the commit-msg hook
//   bun scripts/git-hooks.ts title <text>      check a PR title, which a squash merge makes the commit message
import { readFileSync } from "node:fs";

export const maxLength = 72;

const fix = "Write one imperative sentence, like `Add decision layer` (AGENTS.md, Commits and pull requests).";

export function titleProblem(title: string): string | undefined {
  // Made by `git commit --fixup` and friends, and squashed away before merging.
  if (/^(fixup|squash|amend)! /.test(title)) return undefined;
  if (title.trim() === "") return `The message is empty. ${fix}`;
  if (title.length > maxLength) return `The title is ${title.length} characters; keep it to ${maxLength}. ${fix}`;
  if (!/^([\w./-]+: )?\p{Lu}/u.test(title)) return `Start the title with a capital letter. ${fix}`;
  if (title.endsWith(".")) return "Drop the title's trailing period.";
  return undefined;
}

// The hook sees the message before git strips its comments and the diff below `--verbose`'s scissors line.
export function messageProblem(message: string): string | undefined {
  const lines = message.split(/\r?\n/);
  const scissors = lines.findIndex((line) => /^# -+ >8 -+$/.test(line));
  const text = (scissors === -1 ? lines : lines.slice(0, scissors))
    .filter((line) => !line.startsWith("#") && line.trim() !== "")
    .map((line) => line.trimEnd());
  if (text.length > 1)
    return "Commit messages are one line with no body: no description, no Co-Authored-By or other trailers, no Generated with line. Put the detail in the PR description.";
  return titleProblem(text[0] ?? "");
}

if (import.meta.main) {
  const [command, arg] = process.argv.slice(2);
  if (command === "install") {
    // Outside a git checkout (a tarball, say) there is nothing to install.
    Bun.spawnSync(["git", "config", "core.hooksPath", "scripts/git-hooks"], { stdout: "ignore", stderr: "ignore" });
  } else if ((command === "commit-msg" || command === "title") && arg !== undefined) {
    const problem = command === "title" ? titleProblem(arg) : messageProblem(readFileSync(arg, "utf8"));
    if (problem) {
      console.error(command === "title" ? `PR title: ${problem}` : `commit-msg: ${problem} Commit again with a fixed message.`);
      process.exit(1);
    }
  } else {
    console.error("Usage: bun scripts/git-hooks.ts install | commit-msg <file> | title <text>");
    process.exit(2);
  }
}
