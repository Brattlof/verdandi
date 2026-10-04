import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CommandId,
  CommandRejected,
  type Event,
  type HubKept,
  type HubPin,
  hubThread,
  type SkillChange,
  skillFileCap,
} from "@verdandi/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Engine } from "../event-store/engine.ts";
import { git } from "../git/git.ts";
import { workspaceDir } from "../home/workspace.ts";
import { type HubInstall, readSkillFile, type SkillFolders } from "./skill-files.ts";
import { digest, nameProblem, pathProblem } from "./skills.ts";
import { loadSkillSources } from "./skills-config.ts";

/** A hub skill's files at one commit, by path inside the skill, as text. */
export type HubFiles = ReadonlyMap<string, string>;

/**
 * The most files, and bytes in all, a hub skill may bring: skills are prompts and a few scripts, and every file is in the
 * approval diff, the event log and the hub thread's feed.
 */
const maxFiles = 100;
const maxBytes = 1024 * 1024;

const unavailable = (message: string) => new CommandRejected({ reason: "SkillHubUnavailable", message });

/** Runs git in `cwd` and fails, naming `what` and git's own words, unless it exits 0. Returns its stdout. */
const run = (cwd: string, args: readonly string[], what: string) =>
  git(cwd, args).pipe(
    Effect.mapError((e) => unavailable(e.message)),
    Effect.flatMap((r) =>
      r.code === 0 ? Effect.succeed(r.stdout) : Effect.fail(unavailable(`${what}: ${r.stderr.trim() || `git exited with ${r.code}`}`)),
    ),
  );

/**
 * A bare clone of `url` in a temp folder, removed when the scope closes. Bare, so nothing is checked out and none of the
 * repo's hooks, filters or submodules runs; files are read from its objects.
 */
const cloneBare = (url: string, source: string) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "verdandi-hub-"));
      const repo = join(dir, "repo.git");
      yield* run(dir, ["clone", "--bare", "--quiet", "--", url, repo], `Couldn't fetch the source ${source} (${url})`).pipe(
        Effect.tapError(() => Effect.sync(() => rmSync(dir, { recursive: true, force: true }))),
      );
      return repo;
    }),
    (repo) => Effect.sync(() => rmSync(dirname(repo), { recursive: true, force: true, maxRetries: 3 })),
  );

/** The full commit SHA `ref` (a tag, branch, `HEAD` or SHA) names in `repo`. */
const resolveRef = (repo: string, ref: string, source: string) =>
  ref.startsWith("-")
    ? Effect.fail(unavailable(`${JSON.stringify(ref)} isn't a ref: give a tag, a branch or a commit SHA.`))
    : run(
        repo,
        ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
        `There's no commit ${ref} in the source ${source}. Give a tag, a branch or a full commit SHA it has`,
      ).pipe(Effect.map((out) => out.trim()));

/** The entries of `repo`'s tree at `sha`, all or under `path`: mode, object id, size in bytes and path from the root. */
const listTree = (repo: string, sha: string, source: string, path?: string) =>
  run(
    repo,
    ["ls-tree", "-r", "-l", "-z", "--full-tree", sha, ...(path === undefined ? [] : ["--", path])],
    `Couldn't list ${source} at ${sha}`,
  ).pipe(
    Effect.map((listed) =>
      listed
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf("\t");
          const [mode = "", , oid = "", size = ""] = line.slice(0, tab).split(/\s+/);
          return { mode, oid, size: Number(size), file: line.slice(tab + 1) };
        }),
    ),
  );

/**
 * The files of the skill folder `path` in `repo` at commit `sha`, by path inside the folder, or why they can't be
 * installed: no SKILL.md there (naming the skill folders there are), a link or submodule, a file that isn't text or is
 * over the cap, or too many files or bytes.
 */
const readSkillAt = (repo: string, sha: string, path: string, source: string) =>
  Effect.gen(function* () {
    const where = `${path} in ${source} at ${sha.slice(0, 12)}`;
    const inside = (yield* listTree(repo, sha, source, path)).filter((e) => e.file.startsWith(`${path}/`));
    if (!inside.some((e) => e.file === `${path}/SKILL.md`)) {
      const found = (yield* listTree(repo, sha, source))
        .filter((e) => e.file === "SKILL.md" || e.file.endsWith("/SKILL.md"))
        .map((e) => dirname(e.file))
        .slice(0, 20);
      return yield* Effect.fail(
        unavailable(
          `There's no SKILL.md at ${where}.${found.length > 0 ? ` Skill folders there: ${found.join(", ")}.` : " It has no skill folders."}`,
        ),
      );
    }
    const bytes = inside.reduce((sum, e) => sum + e.size, 0);
    if (inside.length > maxFiles || bytes > maxBytes)
      return yield* Effect.fail(
        unavailable(
          `${where} has ${inside.length} files of ${bytes} bytes, over the ${maxFiles} files or ${maxBytes} bytes a hub skill may bring.`,
        ),
      );
    const files = new Map<string, string>();
    for (const e of inside) {
      const rel = e.file.slice(path.length + 1);
      // 120000 is a link and 160000 a submodule: Verdandi writes neither into the skills folder.
      if (e.mode !== "100644" && e.mode !== "100755")
        return yield* Effect.fail(unavailable(`${where} has ${rel}, a link or submodule, which Verdandi doesn't install.`));
      const wrong = pathProblem(rel);
      if (wrong) return yield* Effect.fail(unavailable(`${where} has a file Verdandi can't install: ${wrong}`));
      if (e.size > skillFileCap)
        return yield* Effect.fail(unavailable(`${where} has ${rel}, ${e.size} bytes, over the ${skillFileCap} a skill file may hold.`));
      const text = yield* run(repo, ["cat-file", "blob", e.oid], `Couldn't read ${rel} of ${where}`);
      // A NUL, or bytes that didn't decode as UTF-8 (the replacement character), mark a file that isn't text.
      if (text.includes("\0") || text.includes("\uFFFD"))
        return yield* Effect.fail(unavailable(`${where} has ${rel}, which isn't UTF-8 text; Verdandi installs only text files.`));
      files.set(rel, text);
    }
    return files as HubFiles;
  });

/**
 * What installing or updating hub skill `skill` writes (DESIGN §14.4), pure: `after` is upstream at the new commit,
 * `local` each file as it is in the profile's folder. A fresh install (`installed` absent) writes every file. An update
 * replaces only files whose local digest is still the one `installed` recorded; any other, edited or deleted by the
 * user, is kept, with upstream's change to it (`before` is upstream at the installed commit) offered in `kept`, unless
 * `take` names it, which replaces it too. Files the user added are never touched. `edited` lists the files the user
 * changed, and `digests` are `after`'s, to record.
 */
export const planHub = (input: {
  readonly skill: string;
  readonly after: HubFiles;
  readonly local: ReadonlyMap<string, string | null>;
  readonly installed?: Readonly<Record<string, string>>;
  readonly before?: HubFiles;
  readonly take?: ReadonlySet<string>;
}) => {
  const { skill, after, local, installed, before = new Map<string, string>(), take = new Set<string>() } = input;
  const paths = [...new Set([...after.keys(), ...Object.keys(installed ?? {})])].toSorted();
  const changes: SkillChange[] = [];
  const kept: HubKept[] = [];
  const edited: string[] = [];
  for (const path of paths) {
    const now = local.get(path) ?? null;
    const next = after.get(path) ?? null;
    const recorded = installed?.[path];
    const isEdited = installed !== undefined && (recorded === undefined ? now !== null : digest(now) !== recorded);
    if (isEdited) edited.push(path);
    if (isEdited && !take.has(path)) {
      const was = before.get(path) ?? null;
      if (was !== next) kept.push({ path, before: was, after: next });
      continue;
    }
    if (now !== next) changes.push({ action: "write_file", skill, path, before: now, after: next });
  }
  return { changes, kept, edited, digests: Object.fromEntries([...after].map(([path, text]) => [path, digest(text)])) };
};

/** What the user asked of the hub: install `skill`, or update it when it's installed. */
export type HubRequest = {
  readonly skill: string;
  readonly source?: string | undefined;
  readonly path?: string | undefined;
  readonly ref?: string | undefined;
  readonly take?: readonly string[] | undefined;
};

const installRow = (r: { readonly pin: string; readonly digests: string }): HubInstall => ({
  pin: JSON.parse(r.pin) as HubPin,
  digests: JSON.parse(r.digests) as Record<string, string>,
});

/** The installed hub skill `skill`, from `skill_installs`, or undefined. */
export const loadInstall = (skill: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(sql<{ pin: string; digests: string }>`select pin, digests from skill_installs where name = ${skill}`, ([row]) =>
      row ? installRow(row) : undefined,
    ),
  );

/** Every installed hub skill, by name. */
export const loadInstalls = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.map(
    sql<{ name: string; pin: string; digests: string }>`select name, pin, digests from skill_installs`,
    (rows) => new Map(rows.map((r): [string, HubInstall] => [r.name, installRow(r)])),
  ),
);

/**
 * Serves the `SkillInstall` RPC: fetches the skill from its source, resolves the ref to a full SHA, works out what
 * installing or updating it writes, and records that as a pending request on the Skills hub thread, which it creates
 * in the profile's workspace the first time. Nothing is written until the user allows it. Answers with the request,
 * or null when the skill is already at that commit with nothing to change.
 */
export const proposeInstall = (home: string, folders: SkillFolders, dispatch: Engine["Service"]["dispatch"], request: HubRequest) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { skill } = request;
    const wrongName = nameProblem(skill);
    if (wrongName) return yield* new CommandRejected({ reason: "InvalidSkill", message: wrongName });
    const installed = yield* loadInstall(skill);
    if (installed && request.source !== undefined && request.source !== installed.pin.source)
      return yield* new CommandRejected({
        reason: "InvalidSkill",
        message: `${skill} is installed from ${installed.pin.source}. Uninstall it first to install it from ${request.source}.`,
      });
    if (!installed && request.take?.length)
      return yield* new CommandRejected({
        reason: "SkillNotInstalled",
        message: `${skill} isn't installed, so there's no edit to take over.`,
      });
    const source = installed?.pin.source ?? request.source;
    if (source === undefined)
      return yield* new CommandRejected({
        reason: "SkillNotInstalled",
        message: `${skill} isn't installed from the hub. Name a source to install it from: verdandi skills install <source> <path>.`,
      });
    const sources = yield* Effect.try({
      try: () => loadSkillSources(home),
      catch: (e) => unavailable(String(e instanceof Error ? e.message : e)),
    });
    const url = sources[source];
    if (url === undefined)
      return yield* Effect.fail(
        unavailable(
          `There's no source ${source} in ${join(home, "skills.yaml")}${Object.keys(sources).length > 0 ? ` (it has ${Object.keys(sources).join(", ")})` : ""}. Add it under sources, e.g. ${source}: https://github.com/<owner>/<repo>.`,
        ),
      );
    const path = installed?.pin.path ?? request.path ?? skill;
    const wrongPath = pathProblem(path);
    if (wrongPath) return yield* new CommandRejected({ reason: "InvalidSkill", message: wrongPath });
    const ref = request.ref ?? installed?.pin.ref ?? "HEAD";
    // Local reads go through skill_manage's guards: a link on the way or an extra folder's overlap refuses the install.
    const readLocal = (paths: Iterable<string>) =>
      Effect.forEach([...paths], (p) => {
        const read = readSkillFile(folders, skill, p);
        return "error" in read
          ? Effect.fail(new CommandRejected({ reason: "InvalidSkill", message: read.error }))
          : Effect.succeed([p, read.text] as const);
      }).pipe(Effect.map((entries) => new Map(entries)));
    if (!installed) {
      const there = yield* readLocal(["SKILL.md"]);
      if (there.get("SKILL.md") !== null)
        return yield* new CommandRejected({
          reason: "InvalidSkill",
          message: `There's already a skill ${skill} in ${folders.profile}, not installed from the hub. Rename or remove its folder, or install the hub skill from a folder of another name.`,
        });
    }
    const planned = yield* Effect.scoped(
      Effect.gen(function* () {
        const repo = yield* cloneBare(url, source);
        const sha = yield* resolveRef(repo, ref, source);
        const after = yield* readSkillAt(repo, sha, path, source);
        // ponytail: upstream at the installed commit, for the kept files' diffs; a force-push that dropped it shows them whole.
        const before = installed
          ? yield* readSkillAt(repo, installed.pin.sha, path, source).pipe(Effect.orElseSucceed((): HubFiles => new Map()))
          : undefined;
        const local = yield* readLocal(new Set([...after.keys(), ...Object.keys(installed?.digests ?? {})]));
        const take = new Set(request.take ?? []);
        const planned = planHub({ skill, after, local, take, ...(installed && before && { installed: installed.digests, before }) });
        const notEdited = [...take].find((p) => !planned.edited.includes(p));
        if (notEdited !== undefined)
          return yield* new CommandRejected({
            reason: "InvalidSkill",
            message: `${notEdited} isn't a file of ${skill} you changed, so there's no edit to take over${planned.edited.length > 0 ? `; you changed ${planned.edited.join(", ")}` : ""}.`,
          });
        return { sha, ...planned };
      }),
    );
    const pin: HubPin = { source, url, path, ref, sha: planned.sha };
    if (installed?.pin.sha === pin.sha && planned.changes.length === 0) return { threadId: hubThread, sha: pin.sha, request: null };
    const commandId = randomUUID() as CommandId;
    yield* dispatch({
      type: "skill.install.propose",
      commandId,
      threadId: hubThread,
      projectPath: workspaceDir(home),
      skill,
      pin,
      ...(installed && { from: installed.pin.sha }),
      changes: planned.changes,
      kept: planned.kept,
      digests: planned.digests,
    });
    const [row] = yield* sql<{ payload: string }>`select payload from requests where id = ${commandId}`;
    const proposed = row && (JSON.parse(row.payload) as Extract<Event, { type: "skill.install.proposed" }>);
    if (!proposed) return yield* Effect.die(new Error(`Hub install ${commandId} was accepted without a request.`));
    return { threadId: hubThread, sha: pin.sha, request: proposed };
  });
