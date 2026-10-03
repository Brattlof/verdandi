import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { type CommandId, historyLabel, lineDiff, type SkillCuration, type SkillSummary, type SkillsView } from "@verdandi/contracts";
import { Effect } from "effect";
import { readServerFile, resolveHome } from "../home/home.ts";
import { connect } from "../rpc/client.ts";
import { listSkills } from "./skill-files.ts";
import { historyText } from "./skill-history.ts";
import { loadSkillFolders } from "./skills-config.ts";

type Client = Effect.Success<ReturnType<typeof connect>>;

const titles = { profile: "Profile skills", archived: "Archived (not loaded)", extra: "Extra folder (read-only)" } as const;

const note = (s: SkillSummary) =>
  `${s.pinned ? " (pinned)" : ""}${s.curation && s.curation.state !== "active" ? ` (${s.curation.state}, last used ${s.curation.usedAt.slice(0, 10)})` : ""}`;

/**
 * Each folder, the profile's first, then its skills: name and description, whether it's pinned, and how long a stale
 * or archived one went unused.
 */
export const skillsText = (view: SkillsView) =>
  view.folders
    .map((folder) => {
      const { skills } = folder;
      const width = Math.max(0, ...skills.map((s) => s.name.length));
      const lines = skills.map((s) => `  ${s.name.padEnd(width)}  ${s.description.replace(/\s+/g, " ")}${note(s)}`);
      return `${titles[folder.source]}  ${folder.path}\n${lines.length > 0 ? lines.join("\n") : "  (none)"}\n`;
    })
    .join("\n");

/**
 * The skills Verdandi created and the pinned ones, read from the database read-only; none when it doesn't exist yet
 * or predates them.
 */
const readCuration = (home: string): { curation: ReadonlyMap<string, SkillCuration>; pins: ReadonlySet<string> } => {
  const none = { curation: new Map(), pins: new Set<string>() };
  const file = join(home, "verdandi.db");
  if (!existsSync(file)) return none;
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    const rows = db.query("select name, state, used_at as usedAt, thread_id as threadId from skills").all() as (SkillCuration & {
      name: string;
    })[];
    const pins = db.query("select name from skill_pins").all() as { name: string }[];
    return { curation: new Map(rows.map(({ name, ...curation }) => [name, curation])), pins: new Set(pins.map((p) => p.name)) };
  } catch {
    return none; // a database verdandid hasn't migrated yet: no skill has a state or a pin
  } finally {
    db?.close();
  }
};

/** The skills subcommands `verdandi skills` and `verdandi chat`'s `/skills` share. */
export const skillsUsage = "list | history <name> | revert <name> <n> | pin <name> | unpin <name> | restore <name>";

const marks = { context: " ", del: "-", add: "+" } as const;

/**
 * Runs a skills subcommand (`skillsUsage`) through verdandid and says how it went, as `verdandi skills` and `/skills`
 * print it. `revert` reverts the `n`th change of `history`, newest first, and shows what it put back.
 */
export const skillsAction = (client: Client, words: readonly string[]) =>
  Effect.gen(function* () {
    const [sub = "list", name, n] = words;
    /** Dispatches `command`: its rejection's message, or undefined. */
    const rejected = (command: Parameters<Client["CommandDispatch"]>[0]) =>
      client.CommandDispatch(command).pipe(
        Effect.as(undefined),
        Effect.catchTag("CommandRejected", (e) => Effect.succeed(e.message)),
      );
    const send = (command: Parameters<Client["CommandDispatch"]>[0], done: string) =>
      Effect.map(rejected(command), (message) => `${message ?? done}\n`);
    const view = yield* client.SkillsList();
    const profile = view.folders.find((f) => f.source === "profile");
    const find = (source: "profile" | "archived") =>
      view.folders
        .filter((f) => f.source === source)
        .flatMap((f) => f.skills)
        .find((s) => basename(s.path) === name);
    if (sub === "list") return skillsText(view);
    if (!name) return `Usage: ${skillsUsage}\n`;
    if (sub === "history") return historyText(name, yield* client.SkillHistoryGet({ skill: name }));
    if (sub === "pin" || sub === "unpin") {
      if (sub === "pin" && !find("profile"))
        return `There's no skill ${name} in ${profile?.path ?? "the profile's skills folder"}. Pins are for the profile's own skills.\n`;
      const done =
        sub === "pin"
          ? `Pinned ${name}: agents can't change it, and Verdandi won't archive it for going unused.`
          : `Unpinned ${name}: agents can propose changes to it again.`;
      return yield* send({ type: `skill.${sub}`, commandId: crypto.randomUUID() as CommandId, skill: name }, done);
    }
    if (sub === "restore") {
      const archived = find("archived");
      if (archived?.curation?.state !== "archived" || !archived.curation)
        return `There's no archived skill ${name} to restore. The list shows the archived ones under Archived; one an agent deleted comes back by reverting the delete in its history.\n`;
      const done = `Restored ${name}: it's back in ${profile?.path ?? "the profile's skills folder"}, and new sessions load it.`;
      return yield* send(
        { type: "skill.restore", commandId: crypto.randomUUID() as CommandId, threadId: archived.curation.threadId, skill: name },
        done,
      );
    }
    if (sub !== "revert") return `Usage: ${skillsUsage}\n`;
    const history = yield* client.SkillHistoryGet({ skill: name });
    const entry = history[Number(n) - 1];
    if (!entry || !Number.isInteger(Number(n)))
      return history.length === 0
        ? historyText(name, history)
        : `Give the number of a change from its history, 1 to ${history.length}:\n${historyText(name, history)}`;
    if (entry.blocked) return `Can't revert change ${n} (${historyLabel(entry)}): ${entry.blocked}\n`;
    const refused = yield* rejected({
      type: "skill.revert",
      commandId: crypto.randomUUID() as CommandId,
      threadId: entry.threadId,
      changeId: entry.changeId,
    });
    if (refused) return `${refused}\n`;
    // The revert is written before its receipt comes back, so the history already says how it went.
    const [revert] = yield* client.SkillHistoryGet({ skill: name });
    if (revert?.reverts !== entry.changeId) return `Reverted change ${n} of ${name}.\n`;
    if (revert.error) return `Didn't revert change ${n}: ${revert.error}\n`;
    const diff = lineDiff(revert.change.before ?? "", revert.change.after ?? "").map((l) => `${marks[l.line]} ${l.text}`);
    return `Reverted change ${n} of ${name} (${historyLabel(entry)}); \`history\` lists the revert, which can be reverted too:\n${diff.join("\n")}\n`;
  });

/**
 * `verdandi skills list`: the profile's skills, its archived ones and those in its extra folders, read from disk;
 * verdandid needn't run. The other subcommands (`skillsUsage`) go through the running verdandid.
 */
export const skills = async (argv: readonly string[]) => {
  const words = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--home");
  const home = resolveHome(argv);
  if (words[0] === "list") {
    const { curation, pins } = readCuration(home);
    process.stdout.write(skillsText(listSkills(loadSkillFolders(home), curation, pins)));
    return;
  }
  if (!words[0] || !words[1]) throw new Error(`Usage: verdandi skills ${skillsUsage} [--home <dir>]`);
  const message = await Effect.runPromise(
    Effect.scoped(Effect.flatMap(connect(readServerFile(home)), (client) => skillsAction(client, words))),
  );
  process.stdout.write(message);
};
