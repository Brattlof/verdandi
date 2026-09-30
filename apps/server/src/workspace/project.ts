import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { CommandRejected } from "@verdandi/contracts";
import { Effect } from "effect";

const invalid = (message: string) => Effect.fail(new CommandRejected({ reason: "InvalidProjectPath", message }));

/**
 * The folder a `thread.create` names, as its real path: `~` expanded, symlinks and a trailing slash
 * resolved (macOS `/tmp` is `/private/tmp`), so every spelling of one folder is one project. It must
 * exist and be a folder; it need not be a git repo.
 */
export const resolveProjectPath = (path: string): Effect.Effect<string, CommandRejected> => {
  const expanded = path.replace(/^~(?=$|[\\/])/, homedir());
  if (!isAbsolute(expanded)) return invalid(`${path} is not an absolute path. Give the folder's full path, starting from the root.`);
  let real: string;
  try {
    real = realpathSync.native(expanded);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return invalid(
      code === "ENOENT" || code === "ENOTDIR"
        ? `${path} does not exist. Check the spelling, or create the folder first.`
        : `verdandid can't open ${path} (${code}). Check that your user can read it.`,
    );
  }
  return statSync(real).isDirectory()
    ? Effect.succeed(real)
    : invalid(`${path} is a file, not a folder. Open the folder that contains it.`);
};
