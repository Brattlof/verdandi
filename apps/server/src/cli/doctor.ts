import { Database } from "bun:sqlite";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatBytes } from "@verdandi/contracts";
import { findClaude } from "@verdandi/harness-claude-code";
import { Effect } from "effect";
import { requireBun } from "../config/bun-version.ts";
import { alive, resolveHome, type ServerFile, serverFile } from "../config/home.ts";
import { migrations } from "../persistence/migrations.ts";
import { connect } from "../rpc/client.ts";
import { attachmentFiles, attachmentsDir, referencedAttachmentsSql } from "../workspace/attachments.ts";

type Status = "ok" | "warn" | "fail";
/** One line of `verdandi doctor`. When it isn't ok, `detail` ends with the fix. */
export type Check = { readonly name: string; readonly status: Status; readonly detail: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The first line `<path> --version` prints, or undefined when it can't be run. */
const version = async (path: string) => {
  try {
    const proc = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out.trim().split(/\r?\n/)[0] : undefined;
  } catch {
    return undefined;
  }
};

const bun = (): Check => {
  try {
    requireBun(Bun.version);
    return { name: "Bun", status: "ok", detail: Bun.version };
  } catch (e) {
    return { name: "Bun", status: "fail", detail: message(e) };
  }
};

const tool = async (name: string, path: string | undefined, missing: Check): Promise<Check> => {
  if (path === undefined) return missing;
  const v = await version(path);
  return v === undefined
    ? { name, status: "warn", detail: `found at ${path}, but \`--version\` failed. Check that it runs from a terminal.` }
    : { name, status: "ok", detail: `${v} (${path})` };
};

const writable = (home: string): Check => {
  if (!existsSync(home)) return { name: "Home", status: "warn", detail: `${home} doesn't exist yet. \`verdandi start\` creates it.` };
  const probe = join(home, `.doctor-${process.pid}`);
  try {
    writeFileSync(probe, "");
    rmSync(probe);
    return { name: "Home", status: "ok", detail: `${home} is writable` };
  } catch (e) {
    return {
      name: "Home",
      status: "fail",
      detail: `can't write to ${home} (${message(e)}). Give your user write access, or pick another home with --home.`,
    };
  }
};

const latestMigration = Math.max(...Object.keys(migrations).map((id) => Number.parseInt(id, 10)));

/** Opens the database read-only: doctor never migrates or changes it. */
const database = (home: string): Check => {
  const file = join(home, "verdandi.db");
  if (!existsSync(file)) return { name: "Database", status: "warn", detail: `no database yet at ${file}. \`verdandi start\` creates it.` };
  let db: Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    const row = db.query("select max(migration_id) as id from effect_sql_migrations").get() as { id: number | null };
    const applied = row.id ?? 0;
    if (applied < latestMigration)
      return {
        name: "Database",
        status: "warn",
        detail: `at migration ${applied} of ${latestMigration}. Restart verdandid to apply the rest.`,
      };
    if (applied > latestMigration)
      return {
        name: "Database",
        status: "fail",
        detail: `at migration ${applied}, newer than this Verdandi knows (${latestMigration}). Upgrade Verdandi.`,
      };
    return { name: "Database", status: "ok", detail: `${file}, migrations current (${applied})` };
  } catch (e) {
    return {
      name: "Database",
      status: "fail",
      detail: `can't read ${file} (${message(e)}). Stop anything else using it, and back it up before repairing it.`,
    };
  } finally {
    db?.close();
  }
};

/** The attachments folder's size, and how many of its files no stored turn references (read-only, like `database`). */
const attachments = (home: string): Check => {
  const name = "Attachments";
  const files = attachmentFiles(attachmentsDir(home));
  if (files.length === 0) return { name, status: "ok", detail: "none stored" };
  const stored = `${files.length} file${files.length === 1 ? "" : "s"}, ${formatBytes(files.reduce((sum, f) => sum + f.size, 0))}`;
  let db: Database | undefined;
  try {
    db = new Database(join(home, "verdandi.db"), { readonly: true });
    const referenced = new Set(
      db
        .query<{ id: string }, []>(referencedAttachmentsSql)
        .all()
        .map((r) => r.id),
    );
    const unreferenced = files.filter((f) => !referenced.has(f.name)).length;
    return {
      name,
      status: "ok",
      detail: `${stored}; ${unreferenced} no turn references, which verdandid removes daily once they're an hour old`,
    };
  } catch (e) {
    return { name, status: "warn", detail: `${stored}; can't tell which a turn references (${message(e)}). See the Database line.` };
  } finally {
    db?.close();
  }
};

/** The token must be accepted, so this calls the API with it; the token itself is never printed. */
const server = async (home: string): Promise<Check> => {
  const name = "verdandid";
  const start = `Start it with: verdandi start --home "${home}"`;
  if (!existsSync(serverFile(home))) return { name, status: "fail", detail: `not running. ${start}` };
  let info: ServerFile;
  try {
    info = JSON.parse(readFileSync(serverFile(home), "utf8")) as ServerFile;
    if (typeof info.port !== "number" || typeof info.token !== "string" || typeof info.pid !== "number")
      throw new Error("missing port, token or pid");
  } catch (e) {
    return { name, status: "fail", detail: `${serverFile(home)} is unreadable (${message(e)}). Delete it. ${start}` };
  }
  if (!alive(info.pid)) return { name, status: "fail", detail: `server.json is left from pid ${info.pid}, which isn't running. ${start}` };
  // Without the token, verdandid answers /rpc with 401: tells it apart from anything else on the port.
  const answer = await fetch(`http://127.0.0.1:${info.port}/rpc`).then(
    (r) => r.status,
    () => undefined,
  );
  if (answer === undefined) return { name, status: "fail", detail: `nothing answers on 127.0.0.1:${info.port}. ${start}` };
  if (answer !== 401) return { name, status: "fail", detail: `something other than verdandid answers on 127.0.0.1:${info.port}. ${start}` };
  const accepted = await Effect.runPromise(
    Effect.scoped(Effect.flatMap(connect(info), (client) => client.HarnessesList())).pipe(
      Effect.timeoutOption("3 seconds"),
      Effect.map((harnesses) => harnesses._tag === "Some"),
      Effect.orElseSucceed(() => false),
    ),
  );
  return accepted
    ? { name, status: "ok", detail: `listening on 127.0.0.1:${info.port} (pid ${info.pid}), token accepted` }
    : { name, status: "fail", detail: `the token in server.json was rejected. Restart verdandid to rewrite it.` };
};

/** Every check, in order. `tools` holds the binaries found on PATH; tests pass their own. */
export const diagnose = async (
  home: string,
  tools: { readonly claude: string | undefined; readonly git: string | undefined } = {
    claude: findClaude(),
    git: Bun.which("git") ?? undefined,
  },
): Promise<readonly Check[]> => [
  bun(),
  await tool("Claude Code", tools.claude, {
    name: "Claude Code",
    status: "fail",
    detail: "not found on PATH. Install it (https://docs.claude.com/en/docs/claude-code) and run `claude` once to log in.",
  }),
  await tool("git", tools.git, { name: "git", status: "warn", detail: "not found on PATH. Install git to see diffs." }),
  writable(home),
  database(home),
  attachments(home),
  await server(home),
];

/** `verdandi doctor`: one line per check; exits non-zero when any check fails. */
export const doctor = async (argv: readonly string[]) => {
  const checks = await diagnose(resolveHome(argv));
  for (const c of checks) console.log(`${c.status.padEnd(4)}  ${c.name.padEnd(11)}  ${c.detail}`);
  if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
};
