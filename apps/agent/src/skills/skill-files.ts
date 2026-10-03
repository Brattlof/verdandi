import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type SkillChange, type SkillCuration, type SkillSource, type SkillsView, skillFileCap } from "@verdandi/contracts";
import type { SkillEdit } from "@verdandi/tools";
import { frontmatter, invertChange, nameProblem, pathProblem } from "./skills.ts";

/**
 * The profile's own skills folder, which Verdandi writes after the user approves and Claude Code loads, the folder
 * archived skills are moved to, which nothing loads, and the read-only extra folders from `skills.yaml`.
 */
export type SkillFolders = { readonly profile: string; readonly archive: string; readonly extra: readonly string[] };

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

const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
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
  if (edit.action === "create" && present(join(folders.archive, edit.skill)))
    return {
      error: `An archived skill is named ${edit.skill}. Ask the user to bring it back (Restore, or Revert on its delete in its history, in the Skills panel or verdandi skills) and patch it, or pick another name.`,
    };
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
 * How `change` would be written now: to its file, or by moving its archived folder back (a create that reverts a
 * delete, which archived the whole folder), or why it can't be: the guard refused, or the file isn't the change's
 * `before` any more, which `stale` says.
 */
const plan = (
  folders: SkillFolders,
  change: SkillChange,
  stale: string,
): { readonly file: string } | { readonly unarchive: true } | { readonly error: string } => {
  const at = target(folders, change.skill, change.path);
  if ("error" in at) return at;
  if (
    change.action === "create" &&
    !present(join(folders.profile, change.skill)) &&
    readIfFile(join(folders.archive, change.skill, "SKILL.md")) === change.after
  )
    return { unarchive: true };
  return readIfFile(at.file) === change.before ? at : { error: stale };
};

/**
 * Writes an approved `change` to the profile's skills folder, or says why it didn't: the guard refused, or the file
 * changed since (`stale`, by default a proposal's). A delete moves the skill's folder to the archive, never deleting it,
 * and a create that reverts one moves it back. Only the reactor calls it.
 */
export const applyChange = (
  folders: SkillFolders,
  change: SkillChange,
  stale = `${change.skill}/${change.path} changed since it was proposed, so nothing was written. Propose the change again against the file as it is now.`,
): string | undefined => {
  try {
    const how = plan(folders, change, stale);
    if ("error" in how) return how.error;
    if ("unarchive" in how || change.action === "delete") return placeSkill(folders, change.skill, change.action === "delete");
    if (change.after === null) rmSync(how.file, { force: true });
    else {
      mkdirSync(dirname(how.file), { recursive: true });
      writeFileSync(how.file, change.after);
    }
    return undefined;
  } catch (e) {
    return `Couldn't write ${change.skill}/${change.path}: ${e instanceof Error ? e.message : String(e)}`;
  }
};

/** Why reverting the written `change` would be refused, as `revertStale` says it. */
export const revertStale = (change: SkillChange) =>
  `${change.skill}/${change.path} changed since this change was written (by a later change or by hand), so reverting it would lose that. Nothing was written.`;

/** Why reverting the written `change` would be refused now, read from disk, or undefined when it can be reverted. */
export const revertBlocked = (folders: SkillFolders, change: SkillChange) => {
  try {
    const how = plan(folders, invertChange(change), revertStale(change));
    return "error" in how ? how.error : undefined;
  } catch (e) {
    return `Couldn't read ${change.skill}/${change.path}: ${e instanceof Error ? e.message : String(e)}`;
  }
};

/**
 * Moves skill `name`'s folder where its state puts it (DESIGN §14.4): into the archive folder when `archived`, out of
 * Claude Code's sight, and back into the skills folder otherwise. Never deletes, and does nothing when it's already
 * there or gone. Says why it couldn't move it, or nothing. Only the reactor and the sweep call it.
 */
export const placeSkill = (folders: SkillFolders, name: string, archived: boolean): string | undefined => {
  const wrong = nameProblem(name);
  if (wrong) return wrong;
  const [loaded, kept] = [join(folders.profile, name), join(folders.archive, name)];
  const [from, to] = archived ? [loaded, kept] : [kept, loaded];
  if (!present(from)) return undefined;
  if (present(to)) return `Couldn't move the skill ${name}: both ${from} and ${to} exist. Rename or move one of them by hand.`;
  try {
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    return undefined;
  } catch (e) {
    return `Couldn't move the skill ${name} from ${from} to ${to}: ${e instanceof Error ? e.message : String(e)}`;
  }
};

/**
 * The profile's skills folder, its archive (when it holds any), then each extra folder, with its skills: the folders in
 * it that hold a SKILL.md, each with its `curation` when Verdandi created it, and its pin when the user pinned it.
 */
export const listSkills = (
  folders: SkillFolders,
  curation: ReadonlyMap<string, SkillCuration> = new Map(),
  pins: ReadonlySet<string> = new Set(),
): SkillsView => {
  const skillsIn = (folder: string, source: SkillSource) => {
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
      const curated = source === "extra" ? undefined : curation.get(name);
      return [
        {
          name: named,
          description: typeof data?.description === "string" ? data.description : "",
          path,
          ...(curated && { curation: curated }),
          ...(source === "profile" && pins.has(name) && { pinned: true }),
        },
      ];
    });
  };
  const all: { path: string; source: SkillSource }[] = [
    { path: folders.profile, source: "profile" },
    { path: folders.archive, source: "archived" },
    ...folders.extra.map((path) => ({ path, source: "extra" as const })),
  ];
  return {
    folders: all.map((f) => ({ ...f, skills: skillsIn(f.path, f.source) })).filter((f) => f.source !== "archived" || f.skills.length > 0),
  };
};

/**
 * The skills an agent can read (DESIGN §14.4), sorted by name: the profile's, then each extra folder's, each name once
 * (the profile's wins), never the archive's. Each with its folder (`path`).
 */
export const readableSkills = (folders: SkillFolders) => {
  const byName = new Map<string, { readonly name: string; readonly description: string; readonly path: string }>();
  for (const folder of listSkills(folders).folders)
    if (folder.source !== "archived") for (const skill of folder.skills) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  return [...byName.values()].toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

/** The files in skill folder `root`, relative and with forward slashes, links inside it followed, at most `max`. */
const filesIn = (root: string, max = 100) => {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir).toSorted();
    } catch {
      return;
    }
    for (const name of names) {
      if (files.length >= max) return;
      const path = join(dir, name);
      let folder: boolean;
      try {
        folder = statSync(path).isDirectory();
      } catch {
        continue; // a broken link
      }
      if (!within(real(path), root)) continue;
      if (!folder) files.push(relative(root, path).split(sep).join("/"));
      else if (depth < 4) walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return files;
};

/**
 * File `path` (default SKILL.md) of skill `name`, for `skill_view`: with SKILL.md, the list of the skill's other
 * files. Guarded like `skill_manage`'s paths: a kebab-case name, a relative path inside the skill with no `..`, and no
 * link leading out of the skill's folder. Says why it can't be read otherwise.
 */
export const viewSkill = (
  folders: SkillFolders,
  name: string,
  path = "SKILL.md",
): { readonly text: string } | { readonly error: string } => {
  const wrong = pathProblem(path);
  if (wrong) return { error: wrong };
  const skill = readableSkills(folders).find((s) => s.name === name);
  if (!skill) return { error: nameProblem(name) ?? `There's no skill named ${name}. skills_list lists the skills there are.` };
  const root = real(skill.path);
  const file = real(join(root, ...path.split("/")));
  if (!within(file, root)) return { error: `${path} leads out of the skill ${name}'s folder, so skill_view won't read it.` };
  const text = readIfFile(file);
  if (text === null) return { error: `The skill ${name} has no file ${path}. View its SKILL.md to see the files it has.` };
  const body = text.length > skillFileCap ? `${text.slice(0, skillFileCap)}\n[cut at ${skillFileCap} characters]` : text;
  if (path !== "SKILL.md") return { text: body };
  const others = filesIn(root).filter((f) => f !== "SKILL.md");
  return {
    text:
      others.length > 0 ? `${body}\n\nThe skill's other files, for skill_view's path:\n${others.map((f) => `- ${f}`).join("\n")}` : body,
  };
};
