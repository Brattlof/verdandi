import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { SkillChange, SkillSource, SkillsView } from "@verdandi/contracts";
import type { SkillEdit } from "@verdandi/tools";
import { frontmatter, nameProblem, pathProblem } from "./skills.ts";

/** The profile's own skills folder, which Verdandi writes after the user approves, and the read-only extra folders from `skills.yaml`. */
export type SkillFolders = { readonly profile: string; readonly extra: readonly string[] };

const real = (path: string) => (existsSync(path) ? realpathSync.native(path) : resolve(path));
const within = (path: string, folder: string) => path === folder || path.startsWith(folder + sep);

/**
 * Why `path` of skill `skill` can't be written, or undefined when it can: a name or path that leaves the skill
 * folder, a symlink anywhere on the way (Verdandi never writes through one), or a read-only extra folder that
 * overlaps the skill folder. Returns the file's absolute path when it can.
 */
const target = (folders: SkillFolders, skill: string, path: string): { readonly file: string } | { readonly error: string } => {
  const wrong = nameProblem(skill) ?? pathProblem(path);
  if (wrong) return { error: wrong };
  mkdirSync(folders.profile, { recursive: true });
  const root = realpathSync.native(folders.profile);
  const parts = [skill, ...path.split("/")];
  for (let i = 1; i <= parts.length; i++) {
    const at = join(root, ...parts.slice(0, i));
    if (isLink(at))
      return { error: `${parts.slice(0, i).join("/")} is a link, and Verdandi never writes through links in the skills folder.` };
    if (!existsSync(at)) break; // nothing below a missing folder exists either
  }
  const folder = join(root, skill);
  const readOnly = folders.extra.map(real).find((extra) => within(folder, extra) || within(extra, folder));
  if (readOnly)
    return { error: `The skill ${skill} overlaps the read-only extra folder ${readOnly} (skills.yaml), which Verdandi never writes.` };
  return { file: join(folder, ...path.split("/")) };
};

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const readIfFile = (file: string) => (existsSync(file) && lstatSync(file).isFile() ? readFileSync(file, "utf8") : null);

/**
 * The change `edit` would make, read from the profile's skills folder: the file as it is and as it would be, or why
 * it can't be proposed. Checked again by the decider (`changeProblem`), and on disk again when it's applied.
 */
export const prepareChange = (folders: SkillFolders, edit: SkillEdit): { readonly change: SkillChange } | { readonly error: string } => {
  const path = edit.action === "create" || edit.action === "delete" ? "SKILL.md" : edit.path;
  const at = target(folders, edit.skill, path);
  if ("error" in at) return at;
  const exists = existsSync(join(folders.profile, edit.skill));
  if (edit.action !== "create" && !exists) {
    const elsewhere = folders.extra.find((f) => existsSync(join(f, edit.skill)));
    return {
      error: elsewhere
        ? `The skill ${edit.skill} is in the read-only extra folder ${elsewhere}, which Verdandi never writes. Create a skill of your own instead.`
        : `There's no skill ${edit.skill} in the profile's skills folder. Create it first, or check the name.`,
    };
  }
  const before = readIfFile(at.file);
  const change = (after: string | null) => ({ change: { action: edit.action, skill: edit.skill, path, before, after } });
  switch (edit.action) {
    case "create":
    case "write_file":
      return change(edit.content);
    case "delete":
      return change(null);
    case "patch": {
      if (before === null) return { error: `The skill ${edit.skill} has no file ${path} to patch.` };
      const found = edit.old === "" ? 0 : before.split(edit.old).length - 1;
      if (found !== 1)
        return {
          error: `\`old\` must match ${path} exactly once, and it matches ${found} times. Quote more of the text around it, exactly as it is.`,
        };
      return change(before.replace(edit.old, () => edit.new));
    }
  }
};

/**
 * Writes an approved `change` to the profile's skills folder (a delete removes the skill's folder), or says why it
 * didn't: the guard refused, or the file changed since it was proposed. Only the reactor calls it.
 */
export const applyChange = (folders: SkillFolders, change: SkillChange): string | undefined => {
  const at = target(folders, change.skill, change.path);
  if ("error" in at) return at.error;
  try {
    if (readIfFile(at.file) !== change.before)
      return `${change.skill}/${change.path} changed since it was proposed, so nothing was written. Propose the change again against the file as it is now.`;
    if (change.after === null) rmSync(dirname(at.file), { recursive: true, force: true });
    else {
      mkdirSync(dirname(at.file), { recursive: true });
      writeFileSync(at.file, change.after);
    }
    return undefined;
  } catch (e) {
    return `Couldn't write ${change.skill}/${change.path}: ${e instanceof Error ? e.message : String(e)}`;
  }
};

/** The profile's skills folder, then each extra folder, with its skills: the folders in it that hold a SKILL.md. */
export const listSkills = (folders: SkillFolders): SkillsView => {
  const skillsIn = (folder: string) => {
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return []; // a folder that doesn't exist (yet) holds no skills
    }
    return names.toSorted().flatMap((name) => {
      const path = join(folder, name);
      let text: string;
      try {
        text = readFileSync(join(path, "SKILL.md"), "utf8"); // links followed: extra folders often link their skills
      } catch {
        return [];
      }
      const data = frontmatter(text);
      const named = typeof data?.name === "string" ? data.name : name;
      return [{ name: named, description: typeof data?.description === "string" ? data.description : "", path }];
    });
  };
  const all: { path: string; source: SkillSource }[] = [
    { path: folders.profile, source: "profile" },
    ...folders.extra.map((path) => ({ path, source: "extra" as const })),
  ];
  return { folders: all.map((f) => ({ ...f, skills: skillsIn(f.path) })) };
};
