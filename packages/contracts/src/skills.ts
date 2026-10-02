import { Schema } from "effect";
import { ThreadId } from "./ids.ts";

/** What `skill_manage` can do to a profile skill (DESIGN §14.4). */
export const SkillAction = Schema.Literals(["create", "patch", "write_file", "delete"]);
export type SkillAction = typeof SkillAction.Type;

/** The most characters a proposed file may hold: skills are prompts, and every proposal is kept in the event log. */
export const skillFileCap = 64 * 1024;

/**
 * A change the agent proposes to one file of a profile skill: `skill` is the skill's folder name, `path` the file
 * inside it, `before` the file as it is (null when it doesn't exist) and `after` as it would be (null when deleted;
 * `delete` removes the whole skill folder, and shows its SKILL.md). The diff the user approves. Untrusted data.
 */
export const SkillChange = Schema.Struct({
  action: SkillAction,
  skill: Schema.String,
  path: Schema.String,
  before: Schema.NullOr(Schema.String),
  after: Schema.NullOr(Schema.String),
});
export type SkillChange = typeof SkillChange.Type;

/**
 * Where a skill lives: the profile's own skills folder, which Verdandi writes and Claude Code loads, the folder archived
 * skills are moved to (kept, not loaded), or a read-only extra folder from `skills.yaml`.
 */
export const SkillSource = Schema.Literals(["profile", "archived", "extra"]);
export type SkillSource = typeof SkillSource.Type;

/**
 * Where a skill Verdandi created is in its life (DESIGN §14.4): `stale` after 14 days unused, still loaded, and
 * `archived` after 30, moved out of the loaded folder and never deleted, until the user restores it.
 */
export const SkillState = Schema.Literals(["active", "stale", "archived"]);
export type SkillState = typeof SkillState.Type;

/** A skill Verdandi created: its state, when it was last used (or created or restored), and the thread that created it. */
export const SkillCuration = Schema.Struct({ state: SkillState, usedAt: Schema.String, threadId: ThreadId });
export type SkillCuration = typeof SkillCuration.Type;

/** One skill: its SKILL.md frontmatter's name and description, and its folder. `curation` only on skills Verdandi created. */
export const SkillSummary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  path: Schema.String,
  curation: Schema.optionalKey(SkillCuration),
});
export type SkillSummary = typeof SkillSummary.Type;

/** The profile's skills folder, its archive, then each extra folder, with the skills in it sorted by folder name. */
export const SkillsView = Schema.Struct({
  folders: Schema.Array(Schema.Struct({ path: Schema.String, source: SkillSource, skills: Schema.Array(SkillSummary) })),
});
export type SkillsView = typeof SkillsView.Type;
