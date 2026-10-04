import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Schema } from "effect";
import { expandHome } from "../projects/project.ts";

/**
 * The profile's workspace: the folder a thread without a project runs in, for chat, chores and anything not about one
 * project (DESIGN §13). It's a git repo so checkpoints, diffs and reverts work there like in any project.
 */
export const workspaceDir = (home: string) => join(home, "workspace");

/** Creates the workspace and makes it a git repo, leaving one that exists alone. Without git it's a plain folder, with no checkpoints. */
export const ensureWorkspace = (home: string) => {
  const dir = workspaceDir(home);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) {
    try {
      Bun.spawnSync(["git", "init", "--quiet"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
    } catch {
      // git isn't installed: `verdandi doctor` says so, and the workspace works without checkpoints.
    }
  }
  return dir;
};

/** Whether `folder` is inside a git repo: it or a folder above it holds `.git` (a folder, or a worktree's file). */
export const inRepo = (folder: string): boolean => {
  if (existsSync(join(folder, ".git"))) return true;
  const up = dirname(folder);
  return up !== folder && inRepo(up);
};

/** Whether `a` and `b` are one folder, however each is spelled (a symlink, a trailing slash). */
export const sameFolder = (a: string, b: string) => {
  const real = (path: string) => (existsSync(path) ? realpathSync.native(path) : resolve(path));
  return real(a) === real(b);
};

/** Whether `folder` is the profile's workspace, however it's spelled. */
export const isWorkspace = (home: string, folder: string) => sameFolder(folder, workspaceDir(home));

/** The CLI remembers one thread per folder, in the Verdandi home. */
export const cliThreadsFile = (home: string) => join(home, "cli-threads.json");
export const readCliThreads = (home: string): Record<string, string> =>
  existsSync(cliThreadsFile(home)) ? JSON.parse(readFileSync(cliThreadsFile(home), "utf8")) : {};

/**
 * The folder `verdandi` and `verdandi run` work in when none is named: the current folder when it's a project (one the
 * CLI has a thread for, or inside a git repo), else the workspace. `--here` and `--workspace` pick one outright.
 */
export const defaultFolder = (home: string, cwd: string, argv: readonly string[]) => {
  if (argv.includes("--here") && argv.includes("--workspace")) throw new Error("Pick one of --here and --workspace.");
  if (argv.includes("--workspace")) return ensureWorkspace(home);
  return argv.includes("--here") || cwd in readCliThreads(home) || inRepo(cwd) ? cwd : ensureWorkspace(home);
};

/** `workspace.yaml` in the Verdandi home: `folders`, folders outside a thread's own that the agent may work in without asking to reach them. */
const WorkspaceFile = Schema.Struct({ folders: Schema.optionalKey(Schema.Array(Schema.String)) });

export const workspaceSettingsFile = (home: string) => join(home, "workspace.yaml");

/**
 * The folders from `workspace.yaml`, as real paths, read when verdandid starts. Each must be an absolute folder that
 * exists; a broken file stops verdandid, naming the file and key.
 */
export const loadTrustedFolders = (home: string): string[] => {
  const file = workspaceSettingsFile(home);
  if (!existsSync(file)) return [];
  try {
    const data = Schema.decodeUnknownSync(WorkspaceFile)(Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}, { onExcessProperty: "error" });
    return (data.folders ?? []).map((folder, i) => {
      const path = expandHome(folder);
      if (!isAbsolute(path)) throw new Error(`folders[${i}]: ${folder} isn't an absolute path.`);
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`folders[${i}]: ${folder} isn't a folder that exists.`);
      return realpathSync.native(path);
    });
  } catch (e) {
    throw new Error(
      `${file}: ${e instanceof Error ? e.message : String(e)}\nFix the file (folders takes a list of absolute folders, e.g. - ~/Downloads), or delete it.`,
    );
  }
};
