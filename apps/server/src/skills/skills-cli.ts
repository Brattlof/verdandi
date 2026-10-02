import type { SkillsView } from "@verdandi/contracts";
import { resolveHome } from "../home/home.ts";
import { listSkills } from "./skill-files.ts";
import { loadSkillFolders } from "./skills-config.ts";

/** Each folder, the profile's first, then its skills: name and description. */
export const skillsText = (view: SkillsView) =>
  view.folders
    .map((folder) => {
      const { skills } = folder;
      const width = Math.max(0, ...skills.map((s) => s.name.length));
      const lines = skills.map((s) => `  ${s.name.padEnd(width)}  ${s.description.replace(/\s+/g, " ")}`);
      const title = folder.source === "profile" ? "Profile skills" : "Extra folder (read-only)";
      return `${title}  ${folder.path}\n${lines.length > 0 ? lines.join("\n") : "  (none)"}\n`;
    })
    .join("\n");

/** `verdandi skills list`: the profile's skills and those in its extra folders, read from disk; verdandid needn't run. */
export const skills = async (argv: readonly string[]) => {
  const [sub] = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--home");
  if (sub !== "list") throw new Error("Usage: verdandi skills list [--home <dir>]");
  process.stdout.write(skillsText(listSkills(loadSkillFolders(resolveHome(argv)))));
};
