import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { makeTempHome, removeTempHome } from "@verdandi/testkit";
import { claudeCodeLoads } from "./context-files.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempHome(d);
});

/** A temporary folder holding `files`, and the paths `claudeCodeLoads` gives relative to it. */
const tree = (files: Record<string, string>) => {
  const root = makeTempHome();
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const loads = (cwd: string, more: Partial<Parameters<typeof claudeCodeLoads>[1]> = {}) =>
    claudeCodeLoads(join(root, cwd), {
      additionalDirectories: (more.additionalDirectories ?? []).map((d) => join(root, d)),
      plugins: (more.plugins ?? []).map((d) => join(root, d)),
      env: more.env ?? {},
    })
      .map((p) => relative(root, p).split("\\").join("/"))
      .filter((p) => !p.startsWith(".."));
  return { loads };
};

test("Claude Code loads instruction files up the tree with their imports, and the repo's rules, skills, commands and agents", () => {
  const { loads } = tree({
    "CLAUDE.md": "Outer rules.",
    "repo/.git/HEAD": "ref: refs/heads/main\n",
    "repo/CLAUDE.md": "@docs/conventions.md and `@not-imported.md`\n```\n@fenced.md\n```",
    "repo/docs/conventions.md": "@../shared.md",
    "repo/shared.md": "Shared.",
    "repo/not-imported.md": "x",
    "repo/fenced.md": "x",
    "repo/AGENTS.md": "Not read: there's a CLAUDE.md.",
    "repo/.claude/rules/style/ts.md": "Rule.",
    "repo/.claude/skills/deploy/SKILL.md": "---\nname: deploy\n---",
    "repo/.claude/commands/ship.md": "Ship it.",
    "repo/app/.claude/agents/reviewer.md": "Reviewer.",
    "repo/app/CLAUDE.local.md": "Mine.",
    "repo/app/sub/CLAUDE.md": "Loads only when the agent works there.",
  });
  expect(loads("repo/app").toSorted()).toEqual(
    [
      "CLAUDE.md",
      "repo/CLAUDE.md",
      "repo/docs/conventions.md",
      "repo/shared.md",
      "repo/app/CLAUDE.local.md",
      "repo/.claude/rules/style/ts.md",
      "repo/.claude/skills/deploy/SKILL.md",
      "repo/.claude/commands/ship.md",
      "repo/app/.claude/agents/reviewer.md",
    ].toSorted(),
  );
});

test("Claude Code reads AGENTS.md only without a CLAUDE.md, and an additional directory's CLAUDE.md only when told to", () => {
  const { loads } = tree({
    "repo/.git/HEAD": "x",
    "repo/AGENTS.md": "Agents.",
    "shared/CLAUDE.md": "Shared instructions.",
    "shared/.claude/skills/notes/SKILL.md": "Notes.",
    "home/skills/review/SKILL.md": "Review.",
  });
  const extra = { additionalDirectories: ["shared"], plugins: ["home"] };
  expect(loads("repo", extra).toSorted()).toEqual([
    "home/skills/review/SKILL.md",
    "repo/AGENTS.md",
    "shared/.claude/skills/notes/SKILL.md",
  ]);
  expect(loads("repo", { ...extra, env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1" } })).toContain("shared/CLAUDE.md");
});
