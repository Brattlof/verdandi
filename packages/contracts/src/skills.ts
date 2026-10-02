import { Schema } from "effect";

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

/** Where a skill lives: the profile's own skills folder, which Verdandi writes, or a read-only extra folder from `skills.yaml`. */
export const SkillSource = Schema.Literals(["profile", "extra"]);
export type SkillSource = typeof SkillSource.Type;

/** One skill: its SKILL.md frontmatter's name and description, and its folder. */
export const SkillSummary = Schema.Struct({ name: Schema.String, description: Schema.String, path: Schema.String });
export type SkillSummary = typeof SkillSummary.Type;

/** The profile's skills folder, then each extra folder, with the skills in it sorted by folder name. */
export const SkillsView = Schema.Struct({
  folders: Schema.Array(Schema.Struct({ path: Schema.String, source: SkillSource, skills: Schema.Array(SkillSummary) })),
});
export type SkillsView = typeof SkillsView.Type;
