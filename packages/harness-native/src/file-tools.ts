import { realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Where the native agent's file tools may go besides the thread's folder (DESIGN §13): the home's `workspace.yaml`
 * folders without asking, `readable` folders of the home (attachments, terminal outputs) for reading, and never the
 * rest of the Verdandi home.
 */
export type Reach = { readonly home: string; readonly folders: readonly string[]; readonly readable: readonly string[] };

/** What a file tool may do with a path: go ahead, ask the user first, or refuse, saying why. */
export type Access =
  | { readonly kind: "allow" }
  | { readonly kind: "ask"; readonly note: string }
  | { readonly kind: "refuse"; readonly why: string };

type Result = { readonly text: string; readonly isError?: boolean };

/** `path` with symlinks resolved as far up as it exists, so a link can't lead a path out of where it seems to be. */
const real = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(real(parent), basename(path));
  }
};

/** Whether `path` is `root` or inside it; case-insensitive on Windows, as `relative` is there. */
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Pure apart from resolving links: whether a file tool may `read` or `write` `path` (relative to `cwd`, the thread's
 * folder). The thread's folder comes first, since a workspace or worktree thread's sits inside the home.
 */
export const access = (path: string, cwd: string, reach: Reach, write: boolean): Access => {
  const target = real(resolve(cwd, path));
  if ([cwd, ...reach.folders].some((root) => inside(real(root), target))) return { kind: "allow" };
  if (!write && reach.readable.some((root) => inside(real(root), target))) return { kind: "allow" };
  if (inside(real(reach.home), target))
    return {
      kind: "refuse",
      why: `${target} is in Verdandi's home, which holds its database, sessions and server token. The native agent never opens it; work in the thread's folder instead.`,
    };
  return {
    kind: "ask",
    note: write
      ? `${target} is outside this thread's folder: Verdandi keeps no checkpoint of it, so this can't be undone.`
      : `${target} is outside this thread's folder.`,
  };
};

/** How much of a file one read returns; the result points to the rest. */
export const readLimits = { lines: 2000, lineChars: 2000, chars: 100_000 };
/** How many paths or matching lines one search returns. */
export const searchLimit = 200;
const grepMaxBytes = 2 * 1024 * 1024;

const str = (args: Readonly<Record<string, unknown>>, key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined);
const num = (args: Readonly<Record<string, unknown>>, key: string) =>
  typeof args[key] === "number" && Number.isInteger(args[key]) && (args[key] as number) > 0 ? (args[key] as number) : undefined;
const fail = (text: string): Result => ({ text, isError: true });
const binary = (bytes: Uint8Array) => bytes.subarray(0, 8192).includes(0);
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The path as the agent should give it back: relative to the thread's folder inside it, else absolute. */
const shown = (cwd: string, path: string) => (inside(real(cwd), path) ? relative(real(cwd), path).split(sep).join("/") || "." : path);

const readTool = async (args: Readonly<Record<string, unknown>>, cwd: string): Promise<Result> => {
  const path = resolve(cwd, str(args, "path") ?? "");
  const info = await stat(path).catch(() => undefined);
  if (!info) return fail(`There's no file at ${path}.`);
  if (info.isDirectory()) return fail(`${path} is a folder. List it with glob.`);
  const bytes = await readFile(path);
  if (binary(bytes)) return fail(`${path} is a binary file (${info.size} bytes); read_file shows text only.`);
  const lines = bytes.toString("utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const from = num(args, "offset") ?? 1;
  const last = Math.min(lines.length, from - 1 + (num(args, "limit") ?? readLimits.lines));
  if (from > lines.length && lines.length > 0) return fail(`${path} has ${lines.length} lines; offset ${from} is past its end.`);
  const out: string[] = [];
  let chars = 0;
  let n = from;
  for (; n <= last; n++) {
    const line = lines[n - 1] ?? "";
    const text = `${n}\t${line.length > readLimits.lineChars ? `${line.slice(0, readLimits.lineChars)} [line cut]` : line}`;
    if (chars + text.length > readLimits.chars && out.length > 0) break;
    out.push(text);
    chars += text.length + 1;
  }
  const end = n - 1;
  const more = end < lines.length ? `\n(Lines ${from}–${end} of ${lines.length}. Read on with offset ${end + 1}.)` : "";
  return { text: lines.length === 0 ? `${path} is empty.` : `${out.join("\n")}${more}` };
};

/** `text` with the line endings of `existing`: an edit or rewrite of a CRLF file keeps it CRLF. */
const endingsOf = (existing: string | undefined, text: string) => (existing?.includes("\r\n") ? text.replace(/\r?\n/g, "\r\n") : text);

const writeTool = async (args: Readonly<Record<string, unknown>>, cwd: string): Promise<Result> => {
  const path = resolve(cwd, str(args, "path") ?? "");
  const content = str(args, "content");
  if (content === undefined) return fail("`content` is required: the whole file.");
  const info = await stat(path).catch(() => undefined);
  if (info?.isDirectory()) return fail(`${path} is a folder.`);
  const existing = info ? await readFile(path, "utf8") : undefined;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, endingsOf(existing, content));
  return { text: `${existing === undefined ? "Created" : "Rewrote"} ${path}.` };
};

const count = (text: string, part: string) => text.split(part).length - 1;

const editTool = async (args: Readonly<Record<string, unknown>>, cwd: string): Promise<Result> => {
  const path = resolve(cwd, str(args, "path") ?? "");
  const before = str(args, "old_string");
  const after = str(args, "new_string");
  if (!before) return fail("`old_string` is required: the exact text to replace. To create a file, use write_file.");
  if (after === undefined) return fail("`new_string` is required.");
  if (before === after) return fail("`old_string` and `new_string` are the same, so there's nothing to change.");
  const existing = await readFile(path, "utf8").catch(() => undefined);
  if (existing === undefined) return fail(`There's no file at ${path}. To create one, use write_file.`);
  const [from, to] = [endingsOf(existing, before), endingsOf(existing, after)];
  const found = count(existing, from);
  if (found === 0) return fail(`\`old_string\` isn't in ${path}. Read the file again and copy the text exactly, indentation included.`);
  if (found > 1 && args.replace_all !== true)
    return fail(`\`old_string\` is in ${path} ${found} times. Give more of the text around it, or set replace_all to change every one.`);
  await writeFile(path, existing.split(from).join(to));
  return { text: `Edited ${path}${found > 1 ? ` (${found} places)` : ""}.` };
};

const skipped = /(^|[\\/])(\.git|node_modules)([\\/]|$)/;

/**
 * The files under `root` matching `pattern`, skipping `.git` and `node_modules` and anything `keep` turns down.
 * ponytail: doesn't read `.gitignore`; upgrade to `git ls-files` in a repo once ignored build output gets in the way.
 */
async function* files(root: string, pattern: string, keep: (path: string) => boolean) {
  for await (const rel of new Bun.Glob(pattern).scan({ cwd: root, onlyFiles: true, dot: true })) {
    if (skipped.test(rel)) continue;
    const path = join(root, rel);
    if (keep(path)) yield path;
  }
}

const globTool = async (args: Readonly<Record<string, unknown>>, cwd: string, keep: (path: string) => boolean): Promise<Result> => {
  const pattern = str(args, "pattern");
  if (!pattern) return fail("`pattern` is required, e.g. `src/**/*.ts`.");
  const root = resolve(cwd, str(args, "path") ?? ".");
  const found: string[] = [];
  let more = false;
  for await (const path of files(root, pattern, keep)) {
    if (found.length === searchLimit) {
      more = true;
      break;
    }
    found.push(shown(cwd, path));
  }
  if (found.length === 0) return { text: `No files under ${root} match ${pattern}.` };
  return { text: `${found.sort().join("\n")}${more ? `\n(The first ${searchLimit}; narrow the pattern for the rest.)` : ""}` };
};

const grepTool = async (args: Readonly<Record<string, unknown>>, cwd: string, keep: (path: string) => boolean): Promise<Result> => {
  const source = str(args, "pattern");
  if (!source) return fail("`pattern` is required: a regular expression.");
  let regex: RegExp;
  try {
    regex = new RegExp(source, args.case_insensitive === true ? "i" : "");
  } catch (e) {
    return fail(`\`pattern\` isn't a valid regular expression: ${why(e)}`);
  }
  const root = resolve(cwd, str(args, "path") ?? ".");
  const info = await stat(root).catch(() => undefined);
  if (!info) return fail(`There's nothing at ${root}.`);
  const paths = info.isDirectory() ? files(root, str(args, "glob") ?? "**/*", keep) : [root];
  const hits: string[] = [];
  for await (const path of paths) {
    const size = (await stat(path).catch(() => undefined))?.size ?? 0;
    if (size === 0 || size > grepMaxBytes) continue;
    const bytes = await readFile(path).catch(() => undefined);
    if (!bytes || binary(bytes)) continue;
    const lines = bytes.toString("utf8").split(/\r?\n/);
    for (const [i, line] of lines.entries()) {
      if (!regex.test(line)) continue;
      if (hits.length === searchLimit)
        return { text: `${hits.join("\n")}\n(The first ${searchLimit} matching lines; narrow the pattern or path for the rest.)` };
      hits.push(`${shown(cwd, path)}:${i + 1}: ${line.length > 300 ? `${line.slice(0, 300)} [line cut]` : line}`);
    }
  }
  return { text: hits.length === 0 ? `No line under ${root} matches ${source}.` : hits.join("\n") };
};

type FileTool = {
  readonly definition: Anthropic.Tool;
  /** Changes files: refused in ask and plan mode. */
  readonly writes: boolean;
  /** The path it reads or writes, relative to the thread's folder. */
  readonly path: (args: Readonly<Record<string, unknown>>) => string;
  readonly run: (args: Readonly<Record<string, unknown>>, cwd: string, keep: (path: string) => boolean) => Promise<Result>;
};

const pathParam = { type: "string", description: "The file's path: relative to the thread's folder, or absolute." } as const;

/** The native agent's own file tools (DESIGN §9.6), in the fixed order they join a session's tools. */
export const fileTools: Record<string, FileTool> = {
  read_file: {
    definition: {
      name: "read_file",
      description: `Reads a text file, with line numbers. Returns up to ${readLimits.lines} lines from \`offset\` (1-based, default 1), and says where to read on when there's more.`,
      input_schema: {
        type: "object",
        properties: {
          path: pathParam,
          offset: { type: "integer", description: "The first line to read, 1-based." },
          limit: { type: "integer", description: "How many lines to read." },
        },
        required: ["path"],
      },
    },
    writes: false,
    path: (args) => str(args, "path") ?? "",
    run: (args, cwd) => readTool(args, cwd),
  },
  write_file: {
    definition: {
      name: "write_file",
      description:
        "Creates a file, or replaces an existing one's whole content, making its folders as needed. A file that uses CRLF line endings keeps them. To change part of a file, use edit_file.",
      input_schema: {
        type: "object",
        properties: { path: pathParam, content: { type: "string", description: "The whole new content." } },
        required: ["path", "content"],
      },
    },
    writes: true,
    path: (args) => str(args, "path") ?? "",
    run: (args, cwd) => writeTool(args, cwd),
  },
  edit_file: {
    definition: {
      name: "edit_file",
      description:
        "Replaces exact text in a file. `old_string` must appear exactly once, unless `replace_all` is set; copy it from read_file's output without the line numbers. Line endings are matched to the file's.",
      input_schema: {
        type: "object",
        properties: {
          path: pathParam,
          old_string: { type: "string", description: "The exact text to replace." },
          new_string: { type: "string", description: "What to put in its place." },
          replace_all: { type: "boolean", description: "Replace every occurrence, not just one." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    writes: true,
    path: (args) => str(args, "path") ?? "",
    run: (args, cwd) => editTool(args, cwd),
  },
  glob: {
    definition: {
      name: "glob",
      description: `Lists the files matching a glob pattern (e.g. \`src/**/*.ts\`) under \`path\` (default: the thread's folder), skipping .git and node_modules. Returns up to ${searchLimit}.`,
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "The glob pattern, relative to `path`." },
          path: { type: "string", description: "The folder to search in; default the thread's folder." },
        },
        required: ["pattern"],
      },
    },
    writes: false,
    path: (args) => str(args, "path") ?? ".",
    run: globTool,
  },
  grep: {
    definition: {
      name: "grep",
      description: `Searches text files for lines matching a regular expression, under \`path\` (a folder, default the thread's folder, or one file), optionally only files matching \`glob\`. Returns up to ${searchLimit} lines as path:line: text.`,
      input_schema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "A JavaScript regular expression." },
          path: { type: "string", description: "The folder or file to search; default the thread's folder." },
          glob: { type: "string", description: "Only search files matching this glob, e.g. `**/*.ts`." },
          case_insensitive: { type: "boolean", description: "Ignore case." },
        },
        required: ["pattern"],
      },
    },
    writes: false,
    path: (args) => str(args, "path") ?? ".",
    run: grepTool,
  },
};

/**
 * Runs a file tool once its path is allowed or approved. A search skips what lies in the refused part of the home.
 * Never throws: a failure is a result with `isError`.
 */
export const runFileTool = async (tool: FileTool, args: Readonly<Record<string, unknown>>, cwd: string, reach: Reach): Promise<Result> => {
  const keep = (path: string) => access(path, cwd, reach, false).kind !== "refuse";
  try {
    return await tool.run(args, cwd, keep);
  } catch (e) {
    return fail(`${tool.definition.name} failed: ${why(e)}`);
  }
};
