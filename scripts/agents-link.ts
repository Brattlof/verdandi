// Links agent-specific skill folders to the canonical .agents/skills.
//   bun scripts/agents-link.ts          create or repair the links
//   bun scripts/agents-link.ts --check  exit 1 if a link is missing or wrong
// On Windows, creating symlinks needs Developer Mode plus `git config core.symlinks true`.
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

// Agents that read project skills from their own folder instead of .agents/skills.
const LINKS = [
  ".claude/skills",
  ".windsurf/skills",
  ".roo/skills",
  ".kiro/skills",
  ".goose/skills",
  ".qwen/skills",
  ".openhands/skills",
  ".continue/skills",
  ".junie/skills",
  ".augment/skills",
  ".trae/skills",
];

const root = join(import.meta.dir, "..");
const check = process.argv.includes("--check");
const slash = (p: string) => p.replaceAll("\\", "/");
let failures = 0;

for (const link of LINKS) {
  const path = join(root, link);
  const target = slash(relative(dirname(path), join(root, ".agents/skills")));
  const stat = await lstat(path).catch(() => null);
  if (stat?.isSymbolicLink() && slash(await readlink(path)) === target) continue;

  if (check) {
    console.error(`${link}: expected a symlink to ${target}`);
    failures++;
  } else if (stat?.isDirectory()) {
    // A real folder may hold someone's skills; never delete it.
    console.error(`${link}: is a real folder. Move its contents into .agents/skills, delete it, and rerun.`);
    failures++;
  } else {
    // A plain file here is a symlink checked out with core.symlinks=false.
    await rm(path, { force: true });
    await mkdir(dirname(path), { recursive: true });
    await symlink(target, path, "dir");
    console.log(`${link} -> ${target}`);
  }
}

process.exit(failures ? 1 : 0);
