import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@verdandi/contracts";
import { childEnv } from "../home/child-env.ts";

/** The home's MCP config: `servers`, and `importClaudeCode`, which also reads Claude Code's own (ADR 0031). */
export const mcpSettingsFile = (home: string) => join(home, "mcp.yaml");
/** A project's own MCP config, relative to the thread's folder: its servers start only once the user trusts them. */
export const projectMcpFile = ".verdandi/mcp.yaml";
/** Claude Code's project-scope MCP config, relative to the thread's folder. */
const claudeProjectFile = ".mcp.json";
/** Claude Code's user config, of which Verdandi reads the `mcpServers` key and nothing else. */
export const claudeUserConfig = () => join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), ".claude.json");

/** One server as a file configures it, before `${VAR}`s are filled in. */
type Spec = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly ask: boolean;
  readonly tools: Readonly<Record<string, { readonly ask?: boolean }>>;
};

/** A config file that can't be used: the message names the file and key, never a value, which may be a token. */
const broken = (file: string, problem: string, fix: string) => new Error(`${file}: ${problem} ${fix}`);
const verdandiFix =
  "Fix the file (servers: a map of names to { command, args, env, ask, tools: { <tool>: { ask } } }; importClaudeCode: true or false, in the home's only), or delete it.";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string");
const stringMap = (v: unknown) => isRecord(v) && Object.values(v).every((s) => typeof s === "string");

/** A server of Verdandi's own files, checked key by key; `where` is its key, e.g. `servers.github`. */
const verdandiSpec = (file: string, where: string, raw: unknown): Spec => {
  const fail = (problem: string) => broken(file, `${where}${problem}`, verdandiFix);
  if (!isRecord(raw)) throw fail(" must be a map with command, and maybe args, env, ask and tools.");
  const unknown = Object.keys(raw).find((k) => !["command", "args", "env", "ask", "tools"].includes(k));
  if (unknown !== undefined) throw fail(`.${unknown} isn't a key a server takes.`);
  if (typeof raw.command !== "string" || raw.command === "") throw fail(".command must be the program to run.");
  if (raw.args !== undefined && !strings(raw.args)) throw fail(".args must be a list of strings.");
  if (raw.env !== undefined && !stringMap(raw.env)) throw fail(".env must map names to strings.");
  if (raw.ask !== undefined && typeof raw.ask !== "boolean") throw fail(".ask must be true or false.");
  if (raw.tools !== undefined && !isRecord(raw.tools)) throw fail(".tools must map tool names to { ask }.");
  const tools: Record<string, { ask?: boolean }> = {};
  for (const [tool, settings] of Object.entries(raw.tools ?? {})) {
    if (!isRecord(settings) || Object.keys(settings).some((k) => k !== "ask") || typeof (settings.ask ?? true) !== "boolean")
      throw fail(`.tools.${tool} must be { ask: true or false }.`);
    tools[tool] = settings.ask === undefined ? {} : { ask: settings.ask as boolean };
  }
  return {
    command: raw.command,
    args: (raw.args ?? []) as string[],
    env: (raw.env ?? {}) as Record<string, string>,
    ask: raw.ask ?? true,
    tools,
  };
};

/** Reads a Verdandi MCP file: its servers by name, and `importClaudeCode` where `home` allows it. */
const readVerdandiFile = (file: string, home: boolean) => {
  if (!existsSync(file)) return { servers: {}, importClaudeCode: false };
  let data: unknown;
  try {
    data = Bun.YAML.parse(readFileSync(file, "utf8")) ?? {};
  } catch {
    throw broken(file, "isn't valid YAML.", verdandiFix);
  }
  if (!isRecord(data)) throw broken(file, "must be a map with servers.", verdandiFix);
  const allowed = home ? ["servers", "importClaudeCode"] : ["servers"];
  const unknown = Object.keys(data).find((k) => !allowed.includes(k));
  if (unknown !== undefined)
    throw broken(
      file,
      `${unknown} isn't a key this file takes${unknown === "importClaudeCode" ? " (it goes in the home's mcp.yaml)" : ""}.`,
      verdandiFix,
    );
  if (data.importClaudeCode !== undefined && typeof data.importClaudeCode !== "boolean")
    throw broken(file, "importClaudeCode must be true or false.", verdandiFix);
  if (data.servers !== undefined && !isRecord(data.servers)) throw broken(file, "servers must map names to servers.", verdandiFix);
  const servers = Object.fromEntries(
    Object.entries(data.servers ?? {}).map(([name, raw]) => [name, verdandiSpec(file, `servers.${name}`, raw)]),
  );
  return { servers, importClaudeCode: data.importClaudeCode === true };
};

/**
 * Reads the `mcpServers` of a Claude Code file, and nothing else in it. Its servers always ask. A remote one (`url`, or
 * `type` other than `stdio`) is left out with a notice.
 */
const readClaudeFile = (file: string, notices: string[]): Record<string, Spec> => {
  if (!existsSync(file)) return {};
  const fix = "Fix it in Claude Code, or set importClaudeCode: false in the Verdandi home's mcp.yaml.";
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // The parser's message can quote the file, which may hold tokens.
    throw broken(file, "isn't valid JSON.", fix);
  }
  const servers = isRecord(data) ? data.mcpServers : undefined;
  if (servers === undefined) return {};
  if (!isRecord(servers)) throw broken(file, "mcpServers must map names to servers.", fix);
  const specs: Record<string, Spec> = {};
  for (const [name, raw] of Object.entries(servers)) {
    if (!isRecord(raw)) throw broken(file, `mcpServers.${name} must be a map.`, fix);
    if (raw.url !== undefined || (raw.type !== undefined && raw.type !== "stdio")) {
      notices.push(
        `Verdandi left out the MCP server ${name} from ${file}: it's a remote server, and Verdandi starts only local (stdio) ones yet.`,
      );
      continue;
    }
    if (typeof raw.command !== "string" || raw.command === "")
      throw broken(file, `mcpServers.${name}.command must be the program to run.`, fix);
    if (raw.args !== undefined && !strings(raw.args)) throw broken(file, `mcpServers.${name}.args must be a list of strings.`, fix);
    if (raw.env !== undefined && !stringMap(raw.env)) throw broken(file, `mcpServers.${name}.env must map names to strings.`, fix);
    specs[name] = {
      command: raw.command,
      args: (raw.args ?? []) as string[],
      env: (raw.env ?? {}) as Record<string, string>,
      ask: true,
      tools: {},
    };
  }
  return specs;
};

/** Fills in `${VAR}` and `${VAR:-default}` from `env`, as Claude Code does; returns the first variable that's missing instead. */
const expand = (text: string, env: Readonly<Record<string, string | undefined>>) => {
  let missing: string | undefined;
  const filled = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback: string | undefined) => {
    const value = env[name] ?? fallback;
    if (value === undefined) missing ??= name;
    return value ?? "";
  });
  return missing === undefined ? { filled } : { missing };
};

/** What one server needs the user to trust before a project's file can start it, by hash for its environment. */
const trustEntry = (name: string, spec: Spec, file: string) => {
  const env = Object.keys(spec.env);
  const quiet = spec.ask ? Object.entries(spec.tools).flatMap(([tool, s]) => (s.ask === false ? [tool] : [])) : ["every tool"];
  return [
    `${name}: ${[spec.command, ...spec.args].join(" ")}`,
    env.length > 0
      ? ` with ${env.join(", ")} set (sha256 ${createHash("sha256").update(JSON.stringify(spec.env)).digest("hex").slice(0, 16)})`
      : "",
    quiet.length > 0 ? `, running ${quiet.join(", ")} without asking` : "",
    ` (${file})`,
  ].join("");
};

/**
 * The MCP servers a native session in `folder` connects to (DESIGN §9.4, ADR 0031), read when it opens: the home's
 * `mcp.yaml` and the folder's `.verdandi/mcp.yaml`, and with `importClaudeCode: true` Claude Code's too: the folder's
 * `.mcp.json` and the `mcpServers` of its user config (`claudeConfig`). On a name clash the project's file beats the
 * home's, and Verdandi's beat Claude Code's. `trust` lists the servers from the folder's own files, which start only
 * once the user trusts that exact list (`project` names them). Each server starts with `env`, Verdandi's environment
 * without its secrets, plus its own variables, with `${VAR}`s filled in from `env`; one naming a variable that isn't set
 * is left out with a notice. A broken file throws, naming the file and key and never a value.
 */
export const loadMcp = (
  home: string,
  folder: string,
  options: { readonly claudeConfig?: string; readonly env?: Readonly<Record<string, string | undefined>> } = {},
) => {
  const env = options.env ?? childEnv();
  const base = Object.fromEntries(Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])));
  const notices: string[] = [];
  const own = readVerdandiFile(mcpSettingsFile(home), true);
  const projectFile = join(folder, projectMcpFile);
  const project = readVerdandiFile(projectFile, false);
  const claudeProject = join(folder, claudeProjectFile);
  const layers = [
    ...(own.importClaudeCode
      ? [
          { servers: readClaudeFile(options.claudeConfig ?? claudeUserConfig(), notices), file: undefined },
          { servers: readClaudeFile(claudeProject, notices), file: claudeProjectFile },
        ]
      : []),
    { servers: own.servers, file: undefined },
    { servers: project.servers, file: projectMcpFile },
  ];
  // Later layers win; `file` is set for a project's own files.
  const chosen = new Map<string, { readonly spec: Spec; readonly file: string | undefined }>();
  for (const layer of layers) for (const [name, spec] of Object.entries(layer.servers)) chosen.set(name, { spec, file: layer.file });
  const servers: McpServer[] = [];
  const trust: string[] = [];
  const fromProject: string[] = [];
  for (const [name, { spec, file }] of chosen) {
    const parts = [spec.command, ...spec.args, ...Object.values(spec.env)].map((text) => expand(text, env));
    const missing = parts.find((p) => p.missing !== undefined)?.missing;
    if (missing !== undefined) {
      notices.push(
        `Verdandi left out the MCP server ${name}: its config names \${${missing}}, which isn't set in verdandid's environment.`,
      );
      continue;
    }
    const [command = "", ...rest] = parts.map((p) => p.filled ?? "");
    const values = rest.slice(spec.args.length);
    servers.push({
      name,
      command,
      args: rest.slice(0, spec.args.length),
      env: { ...base, ...Object.fromEntries(Object.keys(spec.env).map((key, i) => [key, values[i] ?? ""])) },
      ask: spec.ask,
      tools: spec.tools,
    });
    if (file !== undefined) {
      trust.push(trustEntry(name, spec, file));
      fromProject.push(name);
    }
  }
  return { servers, notices, trust, project: fromProject };
};
