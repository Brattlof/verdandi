import { createHash } from "node:crypto";
import { type DecisionAnswer, type Item, type SkillChange, skillFileCap } from "@verdandi/contracts";
import { flagged } from "@verdandi/decisions";
import { containsSecret } from "@verdandi/trajectories";

/** Pure checks on skills (DESIGN §14.4), shared by the decider and the code that touches the skills folder. */

const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why `name` can't be a skill's folder name (the Agent Skills format's rule), or undefined when it can. */
export const nameProblem = (name: string) =>
  namePattern.test(name) && name.length <= 64
    ? undefined
    : `${JSON.stringify(name)} isn't a skill name: use 1 to 64 lowercase letters, digits and single hyphens, e.g. deploy-notes.`;

/**
 * Why `path` isn't a file path inside a skill folder, or undefined when it is: relative, forward slashes, no `.` or
 * `..` segment, no drive letter, colon, backslash or control character. Symlinks are the disk's to check.
 */
export const pathProblem = (path: string) => {
  const segments = path.split("/");
  const outside =
    path === "" ||
    path.startsWith("/") ||
    /[\\:\p{Cc}]/u.test(path) ||
    segments.some((s) => s === "" || s === "." || s === "..") ||
    path.length > 256;
  return outside
    ? `${JSON.stringify(path)} isn't a file path inside the skill: give a relative path with forward slashes and no .. segment, e.g. scripts/check.sh.`
    : undefined;
};

const fence = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** A SKILL.md's YAML frontmatter, or undefined when it has none or it isn't a mapping. */
export const frontmatter = (text: string): Readonly<Record<string, unknown>> | undefined => {
  const yaml = fence.exec(text)?.[1];
  if (yaml === undefined) return undefined;
  try {
    const data: unknown = Bun.YAML.parse(yaml);
    return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** Why `text` isn't a SKILL.md for skill `name`: it needs frontmatter with that `name` and a `description`. */
const skillMdProblem = (name: string, text: string) => {
  const data = frontmatter(text);
  const description = data?.description;
  if (data?.name === name && typeof description === "string" && description.trim() && description.length <= 1024) return undefined;
  return `SKILL.md must start with YAML frontmatter naming the skill and saying when to use it (up to 1024 characters):\n---\nname: ${name}\ndescription: What it does and when to use it.\n---`;
};

/** Why `change` can't be proposed, or undefined when it can: its name and path, what its action needs, its size. */
export const changeProblem = (change: SkillChange): string | undefined => {
  const { action, skill, path, before, after } = change;
  const wrong = nameProblem(skill) ?? pathProblem(path);
  if (wrong) return wrong;
  if ((action === "create" || action === "delete") && path !== "SKILL.md") return `A skill is ${action}d by its SKILL.md, not ${path}.`;
  if (action === "create" && before !== null) return `The skill ${skill} already exists. Patch it, or pick another name.`;
  if ((action === "patch" || action === "delete") && before === null) return `The skill ${skill} has no ${path} to ${action}.`;
  if ((action === "delete") !== (after === null) && action !== "write_file")
    return `A ${action} must ${action === "delete" ? "drop" : "give"} the file's contents.`;
  if (action === "write_file" && after === null && (before === null || path === "SKILL.md"))
    return before === null ? `The skill ${skill} has no ${path} to remove.` : "A skill's SKILL.md is removed by deleting the skill.";
  if (after !== null && after.length > skillFileCap)
    return `${path} would be ${after.length} characters, over the ${skillFileCap} a skill file may hold. Split it into references/ files.`;
  return path === "SKILL.md" && after !== null ? skillMdProblem(skill, after) : undefined;
};

const inverse: Record<SkillChange["action"], SkillChange["action"]> = {
  create: "delete",
  delete: "create",
  patch: "patch",
  write_file: "write_file",
};

/**
 * The change that undoes `change`: its `before` goes back. Reverting a create deletes the skill, a delete creates it
 * again, and a `write_file` that added a file removes it.
 */
export const invertChange = (change: SkillChange): SkillChange => ({
  ...change,
  action: inverse[change.action],
  before: change.after,
  after: change.before,
});

/**
 * A skill file's SHA-256 in hex, or "" for a missing one: a hub install records its upstream files' (DESIGN §14.4), so an
 * update can tell a file the user changed, or deleted, from one it may replace.
 */
export const digest = (text: string | null) => (text === null ? "" : createHash("sha256").update(text).digest("hex"));

/** Why agents can't change skill `skill`: the user pinned it. Says how to go on. */
export const pinnedProblem = (skill: string) =>
  `The user pinned the skill ${skill}, so agents can't change it. Ask the user to unpin it (the Skills panel, or verdandi skills unpin ${skill}), or create a skill of your own.`;

/**
 * Why the proposed file can't be a skill's, or undefined when it can: it holds a secret, or the decision layer's
 * injection scan (`answer`, to `injectionQuestion`) flags it. Skills are untrusted data, scanned like memory (DESIGN
 * §17). Without an answer it's refused: nothing unscanned is proposed.
 */
export const scanSkill = (text: string, answer: DecisionAnswer | undefined) => {
  if (containsSecret(text))
    return "It holds what looks like a secret (a key, token or password). Skills are prompts the agent reads; say where the secret lives instead.";
  if (!answer || flagged(answer))
    return `Verdandi's injection scan flagged it${answer?.why ? ` (${answer.why})` : ""}. Write the skill as plain steps for its task, without text that overrides the agent's instructions or poses as the system, or commands and links that would carry data off this machine.`;
  return undefined;
};

/** The tool calls that load a skill, and the argument that names it. */
const skillTools: ReadonlyMap<string, string> = new Map([
  ["Skill", "skill"],
  ["skill_view", "name"],
  ["mcp__verdandi__skill_view", "name"],
]);

/**
 * The profile skill `item` shows the agent loading, or undefined, the same for every harness: Claude Code's `Skill`
 * tool call, which names a profile skill `verdandi:<name>` (ADR 0020; a bare name counts too, so a use is never
 * missed), and Verdandi's `skill_view` (native: `skill_view`; Claude Code: `mcp__verdandi__skill_view`). The fake
 * harness reports a `Skill` call. A skill read another way (a file tool) goes unseen.
 */
export const skillUsed = (item: Item) => {
  const key = item.kind === "tool.call" ? skillTools.get(item.name) : undefined;
  if (item.kind !== "tool.call" || key === undefined || typeof item.input !== "object" || item.input === null) return undefined;
  const skill = (item.input as Readonly<Record<string, unknown>>)[key];
  return typeof skill === "string" ? skill.replace(/^verdandi:/, "") : undefined;
};
