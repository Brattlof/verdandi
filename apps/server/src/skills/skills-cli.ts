import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { CommandId, SkillCuration, SkillSummary, SkillsView } from "@verdandi/contracts";
import { Effect } from "effect";
import { readServerFile, resolveHome } from "../home/home.ts";
import { connect } from "../rpc/client.ts";
import { listSkills } from "./skill-files.ts";
import { loadSkillFolders } from "./skills-config.ts";

const titles = { profile: "Profile skills", archived: "Archived (not loaded)", extra: "Extra folder (read-only)" } as const;

const note = (s: SkillSummary) =>
  s.curation && s.curation.state !== "active" ? ` (${s.curation.state}, last used ${s.curation.usedAt.slice(0, 10)})` : "";

/** Each folder, the profile's first, then its skills: name and description, and how long a stale or archived one went unused. */
export const skillsText = (view: SkillsView) =>
  view.folders
    .map((folder) => {
      const { skills } = folder;
      const width = Math.max(0, ...skills.map((s) => s.name.length));
      const lines = skills.map((s) => `  ${s.name.padEnd(width)}  ${s.description.replace(/\s+/g, " ")}${note(s)}`);
      return `${titles[folder.source]}  ${folder.path}\n${lines.length > 0 ? lines.join("\n") : "  (none)"}\n`;
    })
    .join("\n");

/** The skills Verdandi created, read from the database read-only; none when it doesn't exist yet or predates them. */
const readCuration = (home: string): ReadonlyMap<string, SkillCuration> => {
  const file = join(home, "verdandi.db");
  if (!existsSync(file)) return new Map();
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    const rows = db.query("select name, state, used_at as usedAt, thread_id as threadId from skills").all() as (SkillCuration & {
      name: string;
    })[];
    return new Map(rows.map(({ name, ...curation }) => [name, curation]));
  } catch {
    return new Map(); // a database verdandid hasn't migrated yet: no skill has a state
  } finally {
    db?.close();
  }
};

const usage = "Usage: verdandi skills list [--home <dir>] | verdandi skills restore <name> [--home <dir>]";

/**
 * `verdandi skills list`: the profile's skills, its archived ones and those in its extra folders, read from disk;
 * verdandid needn't run. `verdandi skills restore <name>`: brings an archived skill back, through the running verdandid.
 */
export const skills = async (argv: readonly string[]) => {
  const [sub, name] = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--home");
  const home = resolveHome(argv);
  if (sub === "list") {
    process.stdout.write(skillsText(listSkills(loadSkillFolders(home), readCuration(home))));
    return;
  }
  if (sub !== "restore" || !name) throw new Error(usage);
  const message = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* connect(readServerFile(home));
        const view = yield* client.SkillsList();
        const archived = view.folders
          .filter((f) => f.source === "archived")
          .flatMap((f) => f.skills)
          .find((s) => basename(s.path) === name && s.curation?.state === "archived");
        if (!archived?.curation)
          return `There's no archived skill ${name}. \`verdandi skills list\` shows the archived ones under Archived.\n`;
        return yield* client
          .CommandDispatch({
            type: "skill.restore",
            commandId: crypto.randomUUID() as CommandId,
            threadId: archived.curation.threadId,
            skill: name,
          })
          .pipe(
            Effect.as(`Restored ${name}: it's back in ${loadSkillFolders(home).profile}, and new sessions load it.\n`),
            Effect.catchTag("CommandRejected", (e) => Effect.succeed(`${e.message}\n`)),
          );
      }),
    ),
  );
  process.stdout.write(message);
};
