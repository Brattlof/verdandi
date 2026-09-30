import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The value after `name` in argv, or undefined when the flag is absent. Fails when the value is missing. */
export const flag = (argv: readonly string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value, e.g. ${name} <value>.`);
  return value;
};

/**
 * The Verdandi home to use: `--home <dir>`, else the default profile. Dev servers pass
 * `--home ./.verdandi-dev` so they never touch the real `~/.verdandi`.
 */
export const resolveHome = (argv: readonly string[]): string => {
  let home: string | undefined;
  try {
    home = flag(argv, "--home");
  } catch {
    throw new Error("--home needs a folder, e.g. --home ./.verdandi-dev");
  }
  return home === undefined ? join(homedir(), ".verdandi", "profiles", "default") : resolve(home);
};

/** Whether a process with this pid exists: tells a running verdandid from a stale `server.json`. */
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0); // signal 0 only checks that the process exists
    return true;
  } catch {
    return false;
  }
};

/** Written by `verdandi start`, read by clients: where the server listens and its token. */
export const serverFile = (home: string) => join(home, "server.json");
export type ServerFile = { readonly port: number; readonly token: string; readonly pid: number };

/** The running server's `server.json`, for clients. Fails with the fix when verdandid isn't running. */
export const readServerFile = (home: string): ServerFile => {
  if (!existsSync(serverFile(home))) throw new Error(`verdandid is not running for ${home}. Start it with: verdandi start`);
  return JSON.parse(readFileSync(serverFile(home), "utf8")) as ServerFile;
};
