import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { Schema } from "effect";
import { expandHome } from "../projects/project.ts";
import type { SkillFolders } from "./skill-files.ts";

/** `skills.yaml` in the Verdandi home: `extraFolders`, read-only folders of skills listed besides the profile's own. */
const SkillsFile = Schema.Struct({ extraFolders: Schema.optionalKey(Schema.Array(Schema.String)) });

export const skillsSettingsFile = (home: string) => join(home, "skills.yaml");

/**
 * The profile's skills folder (`<home>/skills`), its archive (`<home>/skills-archive`) and the extra folders from `skills.yaml`, read when verdandid starts.
 * A broken file stops it, naming the file and key.
 */
export const loadSkillFolders = (home: string): SkillFolders => {
  const profile = join(home, "skills");
  // Not a plugin component's name, so Claude Code never loads it (ADR 0020).
  const archive = join(home, "skills-archive");
  const file = skillsSettingsFile(home);
  if (!existsSync(file)) return { profile, archive, extra: [] };
  try {
    const data = Schema.decodeUnknownSync(SkillsFile)(Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}, { onExcessProperty: "error" });
    const extra = (data.extraFolders ?? []).map(expandHome);
    const relative = extra.find((f) => !isAbsolute(f));
    if (relative !== undefined) throw new Error(`extraFolders: ${relative} isn't an absolute path.`);
    return { profile, archive, extra: extra.map((f) => resolve(f)) };
  } catch (e) {
    throw new Error(
      `${file}: ${e instanceof Error ? e.message : String(e)}\nFix the file (extraFolders takes a list of absolute folders, e.g. - ~/.agents/skills), or delete it.`,
    );
  }
};

/**
 * Makes the Verdandi home a Claude Code plugin whose skills are the profile's (ADR 0020): creates `<home>/skills` and
 * the manifest that names the plugin `verdandi`, so its skills show as `verdandi:<name>`. Returns the plugin folder.
 */
export const skillsPlugin = (home: string) => {
  mkdirSync(join(home, "skills"), { recursive: true });
  mkdirSync(join(home, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(home, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "verdandi", description: "The skills of this Verdandi profile." }, null, 2)}\n`,
  );
  return home;
};
