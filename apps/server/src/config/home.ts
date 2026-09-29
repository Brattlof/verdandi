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
 * The Goldiloop home to use: `--home <dir>`, else the default profile. Dev servers pass
 * `--home ./.goldiloop-dev` so they never touch the real `~/.goldiloop`.
 */
export const resolveHome = (argv: readonly string[]): string => {
  let home: string | undefined;
  try {
    home = flag(argv, "--home");
  } catch {
    throw new Error("--home needs a folder, e.g. --home ./.goldiloop-dev");
  }
  return home === undefined ? join(homedir(), ".goldiloop", "profiles", "default") : resolve(home);
};

/** Written by `goldiloop start`, read by clients: where the server listens and its token. */
export const serverFile = (home: string) => join(home, "server.json");
export type ServerFile = { readonly port: number; readonly token: string; readonly pid: number };
