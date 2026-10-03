import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** The instruction files Claude Code reads in each folder from the root down to its working folder. */
const instructionFiles = ["CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"];
/** Read instead when none of `instructionFiles` is in any of those folders. */
const agentsFiles = ["AGENTS.md", join(".claude", "AGENTS.md")];
/** How deep Claude Code follows `@` imports, and how deep Verdandi looks into rules, commands and agents folders. */
const maxDepth = 5;

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** `cwd` and every folder above it, the root first. */
const ancestors = (cwd: string) => {
  const chain: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    chain.unshift(dir);
    if (dirname(dir) === dir) return chain;
  }
};

/** The Markdown files under `dir`, links followed, down to `maxDepth`. */
const markdownUnder = (dir: string, depth = 0): string[] => {
  let names: string[];
  try {
    names = readdirSync(dir).toSorted();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    if (name.endsWith(".md") && isFile(path)) return [path];
    return depth < maxDepth && !isFile(path) ? markdownUnder(path, depth + 1) : [];
  });
};

/** Each skill's SKILL.md in skills folder `dir`. */
const skillFiles = (dir: string) => {
  try {
    return readdirSync(dir)
      .toSorted()
      .map((name) => join(dir, name, "SKILL.md"))
      .filter(isFile);
  } catch {
    return [];
  }
};

/** What a `.claude` folder, or a plugin, gives Claude Code: its skills, commands and agents. */
const extensions = (dir: string) => [
  ...skillFiles(join(dir, "skills")),
  ...markdownUnder(join(dir, "commands")),
  ...markdownUnder(join(dir, "agents")),
];

/** The files an instruction file imports with `@path`, outside code spans and fences, resolved from its folder. */
const importsOf = (file: string, text: string) => {
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...prose.matchAll(/(?:^|\s)@(\S+)/g)].map(([, path = ""]) =>
    path.startsWith("~/") ? join(homedir(), path.slice(2)) : isAbsolute(path) ? path : resolve(dirname(file), path),
  );
};

/** `files` and what they import, transitively, each once. */
const withImports = (files: readonly string[]) => {
  const seen = new Set<string>();
  const visit = (file: string, depth: number) => {
    if (seen.has(file) || !isFile(file)) return;
    seen.add(file);
    if (depth >= maxDepth) return;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const imported of importsOf(file, text)) visit(imported, depth + 1);
  };
  for (const file of files) visit(file, 0);
  return [...seen];
};

/**
 * The context and skill files Claude Code loads into a session it starts in `cwd`, by its documented rules: the
 * instruction files in `cwd` and every folder above it (`AGENTS.md` when there are none) with their `@` imports; the
 * `.claude` rules, skills, commands and agents from the repository's root (the nearest folder above holding `.git`)
 * down to `cwd`; each additional directory's `.claude` skills, commands and agents, and its instruction files and rules
 * too when `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` is set; and each plugin's skills, commands and agents (the
 * profile's skills, ADR 0020). A superset is fine, since only flagged files matter; files that load later (a
 * subfolder's, as the agent works there) are left out.
 */
// ponytail: the user's own ~/.claude (CLAUDE.md, rules, skills) isn't scanned, as the user's own configuration, nor
// files that load on demand. Upgrade: scan them too if an agent or a tool turns out to write there.
export const claudeCodeLoads = (
  cwd: string,
  options: {
    readonly additionalDirectories: readonly string[];
    readonly plugins: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
  },
): string[] => {
  const chain = ancestors(cwd);
  const instructions = chain.flatMap((dir) => instructionFiles.map((f) => join(dir, f))).filter(isFile);
  const memory = instructions.length > 0 ? instructions : chain.flatMap((dir) => agentsFiles.map((f) => join(dir, f))).filter(isFile);
  const root = chain.findLastIndex((dir) => existsSync(join(dir, ".git")));
  const project = root < 0 ? chain.slice(-1) : chain.slice(root);
  const flag = options.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD;
  const extra = flag && flag !== "0" && flag.toLowerCase() !== "false" ? options.additionalDirectories : [];
  return [
    ...new Set([
      ...withImports([...memory, ...extra.flatMap((dir) => instructionFiles.map((f) => join(dir, f)))]),
      ...[...project, ...extra].flatMap((dir) => markdownUnder(join(dir, ".claude", "rules"))),
      ...[...project, ...options.additionalDirectories].flatMap((dir) => extensions(join(dir, ".claude"))),
      ...options.plugins.flatMap(extensions),
    ]),
  ];
};
