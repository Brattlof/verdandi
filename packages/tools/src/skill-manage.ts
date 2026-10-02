import { Effect } from "effect";
import { defineTool, type ToolAt, ToolFailed } from "./define.ts";

/** What the agent asked `skill_manage` to do, before verdandid reads the skill's file. */
export type SkillEdit =
  | { readonly action: "create"; readonly skill: string; readonly content: string }
  | { readonly action: "write_file"; readonly skill: string; readonly path: string; readonly content: string }
  | { readonly action: "patch"; readonly skill: string; readonly path: string; readonly old: string; readonly new: string }
  | { readonly action: "delete"; readonly skill: string };

/**
 * Proposes `edit` to the user and waits for their answer: what to tell the agent when it was written, or a
 * `ToolFailed` when it was refused (a scan hit, a path outside the skills folder), declined or couldn't be written.
 */
export type ProposeSkill = (edit: SkillEdit, at: ToolAt) => Effect.Effect<string, ToolFailed>;

const missing = (name: string, action: string) => Effect.fail(new ToolFailed({ message: `\`${name}\` is required to ${action}.` }));

/**
 * `skill_manage` (DESIGN §14.4): the agent proposes a change to one of the user's skills, in the Agent Skills
 * format, in the profile's skills folder. The user sees the diff and allows or declines it; nothing is written
 * until they allow it, so the call waits for their answer.
 */
export const skillManageTool = (propose: ProposeSkill) =>
  defineTool({
    name: "skill_manage",
    description:
      "Propose a change to one of the user's Verdandi skills (Agent Skills format: a folder with a SKILL.md whose YAML frontmatter has name and description, plus optional scripts/, references/ and templates/). Use it to save a procedure that worked and will come up again, or to fix a skill that led you wrong. The user reviews the diff and allows or declines it; nothing is written until they do, and new sessions load it. Prefer a small patch over a rewrite.",
    params: {
      action: {
        type: "string",
        description:
          '"create" a skill (content: the whole SKILL.md), "patch" a file of it (old → new, old matching exactly once), "write_file" into it (path, content), or "delete" it.',
      },
      name: {
        type: "string",
        description: "The skill's name, which is its folder: lowercase letters, digits and hyphens, e.g. deploy-notes.",
      },
      content: {
        type: "string",
        description: "create: the whole SKILL.md, frontmatter first. write_file: the file's contents.",
        optional: true,
      },
      path: {
        type: "string",
        description: "write_file: the file inside the skill, e.g. scripts/check.sh. patch: the file to patch (default SKILL.md).",
        optional: true,
      },
      old: { type: "string", description: "patch: the exact text to replace, matching exactly once.", optional: true },
      new: { type: "string", description: "patch: the text to put in its place.", optional: true },
    },
    run: (args, at) => {
      const skill = args.name;
      switch (args.action) {
        case "create":
          return args.content === undefined
            ? missing("content", "create a skill")
            : propose({ action: "create", skill, content: args.content }, at);
        case "write_file":
          if (args.path === undefined) return missing("path", "write a file");
          if (args.content === undefined) return missing("content", "write a file");
          return propose({ action: "write_file", skill, path: args.path, content: args.content }, at);
        case "patch":
          if (args.old === undefined) return missing("old", "patch");
          if (args.new === undefined) return missing("new", "patch");
          return propose({ action: "patch", skill, path: args.path ?? "SKILL.md", old: args.old, new: args.new }, at);
        case "delete":
          return propose({ action: "delete", skill }, at);
        default:
          return Effect.fail(new ToolFailed({ message: '`action` must be "create", "patch", "write_file" or "delete".' }));
      }
    },
  });
