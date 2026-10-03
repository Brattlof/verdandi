import { Schema } from "effect";
import { ThreadId } from "./ids.ts";

/** What `skill_manage` can do to a profile skill (DESIGN §14.4). */
export const SkillAction = Schema.Literals(["create", "patch", "write_file", "delete"]);
export type SkillAction = typeof SkillAction.Type;

/** The most characters a proposed file may hold: skills are prompts, and every proposal is kept in the event log. */
export const skillFileCap = 64 * 1024;

/**
 * A change to one file of a profile skill: `skill` is the skill's folder name, `path` the file inside it, `before` the
 * file as it is (null when it doesn't exist) and `after` as it would be (null when deleted; `delete` moves the whole
 * skill folder to the archive, and shows its SKILL.md, and a `write_file` to null, which only a revert makes, removes
 * the file). The diff the user approves. Untrusted data.
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

/**
 * One skill: its SKILL.md frontmatter's name and description, and its folder. `curation` only on skills Verdandi
 * created; `pinned` when the user pinned it, so no agent can change it and curation leaves it alone.
 */
export const SkillSummary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  path: Schema.String,
  curation: Schema.optionalKey(SkillCuration),
  pinned: Schema.optionalKey(Schema.Boolean),
});
export type SkillSummary = typeof SkillSummary.Type;

/** The profile's skills folder, its archive, then each extra folder, with the skills in it sorted by folder name. */
export const SkillsView = Schema.Struct({
  folders: Schema.Array(Schema.Struct({ path: Schema.String, source: SkillSource, skills: Schema.Array(SkillSummary) })),
});
export type SkillsView = typeof SkillsView.Type;

/**
 * A change written to a skill (DESIGN §14.4): an approved proposal, or a revert of an earlier change (`reverts`, its
 * id). `threadId` is the thread whose log holds it, `at` when it was written, and `error` why it wasn't. `blocked` says
 * why reverting it now would be refused (it wasn't written, or the file changed since), read from disk when listed.
 */
export const SkillHistoryEntry = Schema.Struct({
  changeId: Schema.String,
  threadId: ThreadId,
  at: Schema.String,
  change: SkillChange,
  reverts: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  blocked: Schema.optionalKey(Schema.String),
});
export type SkillHistoryEntry = typeof SkillHistoryEntry.Type;

const verbs: Record<SkillAction, string> = { create: "created", patch: "patched", write_file: "wrote", delete: "deleted" };

/** What a history entry did, in a few words: e.g. `patched SKILL.md`, or `reverted: removed scripts/check.sh`. */
export const historyLabel = (entry: SkillHistoryEntry) => {
  const { action, path, after } = entry.change;
  const what =
    action === "write_file" && after === null
      ? `removed ${path}`
      : `${verbs[action]} ${action === "create" || action === "delete" ? "the skill" : path}`;
  return entry.reverts ? `reverted: ${what}` : what;
};
