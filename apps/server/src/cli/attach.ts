import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { AttachmentUpload } from "@verdandi/contracts";
import { expandHome } from "../projects/project.ts";

/**
 * The file `/attach <path>` names, read to go with the next turn. The path is the rest of the line, so
 * spaces need no quotes (`/attach C:\Users\a b\shot.png`), though quotes are dropped; `~` is the home folder, and
 * relative paths start at `cwd`.
 * A string is what went wrong, naming the path.
 */
export const readAttachment = (argument: string, cwd: string): AttachmentUpload | string => {
  const raw = argument.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!raw) return "Name a file to attach, e.g. /attach screenshot.png";
  const path = resolve(cwd, expandHome(raw));
  if (!existsSync(path)) return `${path} doesn't exist. Check the path.`;
  if (!statSync(path).isFile()) return `${path} is a folder; attach a file.`;
  const mediaType = Bun.file(path).type.split(";", 1)[0] || "application/octet-stream";
  return { name: basename(path), mediaType, data: readFileSync(path).toString("base64") };
};
