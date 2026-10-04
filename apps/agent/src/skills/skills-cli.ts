import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import {
  type CommandId,
  type Event,
  type HubPin,
  historyLabel,
  hubThread,
  lineDiff,
  type SkillCuration,
  type SkillSummary,
  type SkillsView,
} from "@verdandi/contracts";
import { Effect } from "effect";
import { installText, installTitle } from "../cli/requests.ts";
import { readServerFile, resolveHome } from "../home/home.ts";
import { connect } from "../rpc/client.ts";
import { type HubInstall, listSkills } from "./skill-files.ts";
import { historyText } from "./skill-history.ts";
import { loadSkillFolders } from "./skills-config.ts";

type Client = Effect.Success<ReturnType<typeof connect>>;

const titles = { profile: "Profile skills", archived: "Archived (not loaded)", extra: "Extra folder (read-only)" } as const;

/** Where a hub skill comes from, in a few words: source, commit, the ref asked for, and the files the user changed. */
const hubLabel = (hub: HubPin & { readonly edited: readonly string[] }) =>
  `hub: ${hub.source} ${hub.path} at ${hub.sha.slice(0, 12)}${hub.ref === hub.sha ? "" : ` (${hub.ref})`}${hub.edited.length > 0 ? `; you changed ${hub.edited.join(", ")}` : ""}`;

const note = (s: SkillSummary) =>
  `${s.pinned ? " (pinned)" : ""}${s.curation && s.curation.state !== "active" ? ` (${s.curation.state}, last used ${s.curation.usedAt.slice(0, 10)})` : ""}${s.hub ? ` (${hubLabel(s.hub)})` : ""}`;

/**
 * Each folder, the profile's first, then its skills: name and description, whether it's pinned, how long a stale or
 * archived one went unused, and where a hub skill comes from.
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
 * The skills Verdandi created, the pinned ones and the installed hub skills, read from the database read-only; none
 * when it doesn't exist yet or predates them.
 */
const readCuration = (
  home: string,
): { curation: ReadonlyMap<string, SkillCuration>; pins: ReadonlySet<string>; installs: ReadonlyMap<string, HubInstall> } => {
  const none = { curation: new Map(), pins: new Set<string>(), installs: new Map() };
  const file = join(home, "verdandi.db");
  if (!existsSync(file)) return none;
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    const rows = db.query("select name, state, used_at as usedAt, thread_id as threadId from skills").all() as (SkillCuration & {
      name: string;
    })[];
    const pins = db.query("select name from skill_pins").all() as { name: string }[];
    const curation = new Map(rows.map(({ name, ...curation }) => [name, curation]));
    let installs = new Map<string, HubInstall>();
    try {
      const hub = db.query("select name, pin, digests from skill_installs").all() as { name: string; pin: string; digests: string }[];
      installs = new Map(
        hub.map((r) => [r.name, { pin: JSON.parse(r.pin) as HubPin, digests: JSON.parse(r.digests) as Record<string, string> }]),
      );
    } catch {
      // a database from before the hub: nothing is installed
    }
    return { curation, pins: new Set(pins.map((p) => p.name)), installs };
  } catch {
    return none; // a database verdandid hasn't migrated yet: no skill has a state or a pin
  } finally {
    db?.close();
  }
};

/** The skills subcommands `verdandi skills` and `verdandi chat`'s `/skills` share. */
export const skillsUsage =
  "list | history <name> | revert <name> <n> | pin <name> | unpin <name> | restore <name> | install <source> <path> [--ref <ref>] | update <name> [--ref <ref>] [--take <file>]... | uninstall <name>";

const marks = { context: " ", del: "-", add: "+" } as const;

/** Splits `--ref <ref>` and each `--take <file>` from the other words. */
const hubFlags = (words: readonly string[]) => {
  const rest: string[] = [];
  const take: string[] = [];
  let ref: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (word === "--ref") ref = words[++i];
    else if (word === "--take") {
      const file = words[++i];
      if (file !== undefined) take.push(file);
    } else rest.push(word);
  }
  return { rest, ref, take };
};

type InstallProposed = Extract<Event, { type: "skill.install.proposed" }>;

/**
 * Asks the user about a hub install request in a terminal: true to allow it, false to leave it waiting on the Skills
 * hub thread. Without one (`verdandi chat`'s `/skills`), it waits there.
 */
export type Confirm = (request: InstallProposed) => Effect.Effect<boolean>;

const waits = `It waits for your answer on the Skills hub thread: open it in the web UI, or run verdandi chat --thread ${hubThread}.`;

/**
 * `install` and `update` (DESIGN §14.4): fetches through verdandid, prints every file's diff and the scans' advice,
 * and asks with `confirm`; allowing it writes the files, and says how that went.
 */
const hubAction = (client: Client, sub: "install" | "update", words: readonly string[], confirm?: Confirm) =>
  Effect.gen(function* () {
    const { rest, ref, take } = hubFlags(words);
    const [first, second] = rest;
    if (!first || (sub === "install" && !second)) return `Usage: ${skillsUsage}\n`;
    // Install names the skill by its folder in the source; the profile keeps it under the same name.
    const path = (second ?? "").replace(/\/+$/, "");
    const skill = sub === "install" ? (path.split("/").at(-1) ?? "") : first;
    const proposed = yield* client
      .SkillInstall({
        skill,
        ...(sub === "install" && { source: first, path }),
        ...(ref !== undefined && { ref }),
        ...(take.length > 0 && { take }),
      })
      .pipe(Effect.catchTag("CommandRejected", (e) => Effect.succeed(e.message)));
    if (typeof proposed === "string") return `${proposed}\n`;
    const { request, sha } = proposed;
    if (!request) return `${skill} is already at ${sha.slice(0, 12)}, with nothing to change.\n`;
    const shown = `Verdandi would ${installTitle(request)} in your profile's skills folder:\n${installText(request)}`;
    if (!confirm) return `${shown}${waits}\n`;
    process.stdout.write(shown);
    if (!(yield* confirm(request))) return `Not installed. ${waits}\n`;
    const refused = yield* client
      .CommandDispatch({
        type: "approval.respond",
        commandId: crypto.randomUUID() as CommandId,
        threadId: hubThread,
        requestId: request.requestId,
        resolution: { decision: "allow" },
      })
      .pipe(
        Effect.as(undefined),
        Effect.catchTag("CommandRejected", (e) => Effect.succeed(e.message)),
      );
    if (refused) return `${refused}\n`;
    // The install is written before its answer's receipt comes back, so the list and the history already say how it went.
    const failed = (yield* client.SkillHistoryGet({ skill })).find((e) => e.changeId.startsWith(`${request.requestId}:`) && e.error);
    if (failed?.error) return `Nothing was installed: ${failed.error}\n`;
    const now = (yield* client.SkillsList()).folders
      .flatMap((f) => (f.source === "profile" ? f.skills : []))
      .find((s) => basename(s.path) === skill);
    return now?.hub?.sha === request.pin.sha
      ? `${sub === "install" ? "Installed" : "Updated"} ${skill} at ${request.pin.sha.slice(0, 12)}; new sessions load it.\n`
      : `Nothing was installed; verdandid's log says why.\n`;
  });

/**
 * Runs a skills subcommand (`skillsUsage`) through verdandid and says how it went, as `verdandi skills` and `/skills`
 * print it. `revert` reverts the `n`th change of `history`, newest first, and shows what it put back. `install` and
 * `update` ask with `confirm` when there's a terminal to ask in.
 */
export const skillsAction = (client: Client, words: readonly string[], confirm?: Confirm) =>
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
    if (sub === "install" || sub === "update") return yield* hubAction(client, sub, words.slice(1), confirm);
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
    if (sub === "uninstall") {
      const refused = yield* rejected({ type: "skill.uninstall", commandId: crypto.randomUUID() as CommandId, skill: name });
      if (refused) return `${refused}\n`;
      const still = (yield* client.SkillsList()).folders.some(
        (f) => f.source === "profile" && f.skills.some((s) => basename(s.path) === name),
      );
      return still
        ? `Uninstalled ${name}, but its folder couldn't be moved to the archive, so Claude Code still loads it; verdandid's log says why. Move or delete it by hand.\n`
        : `Uninstalled ${name}: its folder moved to the archive, where nothing loads it.\n`;
    }
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

/** Asks y/n on the terminal, through Bun's `confirm`; with no terminal, the request stays waiting. */
const terminalConfirm: Confirm = () => Effect.sync(() => process.stdin.isTTY === true && confirm("Allow it?"));

/**
 * `verdandi skills list`: the profile's skills, its archived ones and those in its extra folders, read from disk;
 * verdandid needn't run. The other subcommands (`skillsUsage`) go through the running verdandid.
 */
export const skills = async (argv: readonly string[]) => {
  const words = argv.filter((a, i) => a !== "--home" && argv[i - 1] !== "--home");
  const home = resolveHome(argv);
  if (words[0] === "list") {
    const { curation, pins, installs } = readCuration(home);
    process.stdout.write(skillsText(listSkills(loadSkillFolders(home), curation, pins, installs)));
    return;
  }
  if (!words[0] || !words[1]) throw new Error(`Usage: verdandi skills ${skillsUsage} [--home <dir>]`);
  const message = await Effect.runPromise(
    Effect.scoped(Effect.flatMap(connect(readServerFile(home)), (client) => skillsAction(client, words, terminalConfirm))),
  );
  process.stdout.write(message);
};
