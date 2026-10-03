import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Every value of a flag that may repeat (`--route auto --route claude-code/opus/medium`), each written `--name value`
 * or `--name=value`, where the value is everything after the first `=`. Fails when one is missing.
 */
export const flags = (argv: readonly string[], name: string): string[] =>
  argv.flatMap((arg, i) => {
    if (arg !== name && !arg.startsWith(`${name}=`)) return [];
    const value = arg === name ? argv[i + 1] : arg.slice(name.length + 1);
    if (!value || (arg === name && value.startsWith("--"))) throw new Error(`${name} needs a value, e.g. ${name} <value>.`);
    return [value];
  });

/** The value of `name` in argv (`--name value` or `--name=value`), or undefined when the flag is absent. Fails when the value is missing. */
export const flag = (argv: readonly string[], name: string): string | undefined => flags(argv, name)[0];

/**
 * The Verdandi home to use: `--home <dir>` (or `--home=<dir>`), else the default profile. Dev servers pass
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

/** Written by verdandid when it starts, read by clients: where the server listens and its token. */
export const serverFile = (home: string) => join(home, "server.json");
export type ServerFile = { readonly port: number; readonly token: string; readonly pid: number };

/** The `server.json` of the verdandid running for `home`, or undefined when none is (no file, or one a stopped process left). */
export const runningServer = (home: string): ServerFile | undefined => {
  if (!existsSync(serverFile(home))) return undefined;
  const server = JSON.parse(readFileSync(serverFile(home), "utf8")) as ServerFile;
  return alive(server.pid) ? server : undefined;
};

/** The running server's `server.json`, for clients. Fails with the fix when verdandid isn't running. */
export const readServerFile = (home: string): ServerFile => {
  const server = runningServer(home);
  if (!server)
    throw new Error(
      `verdandid is not running for ${home}. Run \`verdandi\`, which runs it while you chat, or \`verdandi start\` to keep it running.`,
    );
  return server;
};
