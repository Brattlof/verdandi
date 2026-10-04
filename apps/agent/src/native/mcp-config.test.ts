import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempHome, removeTempHome } from "@verdandi/testkit";
import { loadMcp } from "./mcp-config.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) removeTempHome(h);
});

/** A home, a project folder in it, and a stand-in for Claude Code's user config, with the given files written. */
const setup = (files: { readonly home?: string; readonly project?: string; readonly mcpJson?: string; readonly claude?: string }) => {
  const home = makeTempHome();
  homes.push(home);
  const folder = join(home, "my project");
  mkdirSync(join(folder, ".verdandi"), { recursive: true });
  const claudeConfig = join(home, "claude.json");
  if (files.home) writeFileSync(join(home, "mcp.yaml"), files.home);
  if (files.project) writeFileSync(join(folder, ".verdandi", "mcp.yaml"), files.project);
  if (files.mcpJson) writeFileSync(join(folder, ".mcp.json"), files.mcpJson);
  if (files.claude) writeFileSync(claudeConfig, files.claude);
  return { home, folder, claudeConfig };
};

const env = { PATH: "/usr/bin", GITHUB_TOKEN: "ghp_fixture", VERDANDI_HOME_ONLY: undefined };

test("home and project servers merge, the project's winning a clash; only the project's need trust, and variables fill in", () => {
  const { home, folder } = setup({
    home: `servers:
  github:
    command: npx
    args: [-y, github-server]
    env: { GITHUB_TOKEN: "\${GITHUB_TOKEN}" }
    ask: false
  docs:
    command: docs-server
    tools: { search: { ask: false } }
`,
    project: `servers:
  docs:
    command: ./tools/docs-server
    args: ["--root", "\${DOCS_ROOT:-.}"]
`,
  });
  const loaded = loadMcp(home, folder, { env });
  expect(loaded.servers.map((s) => [s.name, s.command, s.args, s.ask, s.tools])).toEqual([
    ["github", "npx", ["-y", "github-server"], false, {}],
    ["docs", "./tools/docs-server", ["--root", "."], true, {}],
  ]);
  expect(loaded.servers[0]?.env).toEqual({ PATH: "/usr/bin", GITHUB_TOKEN: "ghp_fixture" });
  expect(loaded.project).toEqual(["docs"]);
  expect(loaded.trust).toEqual([`docs: ./tools/docs-server --root \${DOCS_ROOT:-.} (.verdandi/mcp.yaml)`]);
  expect(loaded.notices).toEqual([]);
});

test("importClaudeCode reads .mcp.json and the user config's mcpServers, which always ask; Verdandi's files win a clash", () => {
  const { home, folder, claudeConfig } = setup({
    home: "importClaudeCode: true\nservers:\n  shared: { command: verdandi-shared }\n",
    mcpJson: JSON.stringify({ mcpServers: { repo: { command: "repo-server", env: { MODE: "x" } }, shared: { command: "claude-shared" } } }),
    claude: JSON.stringify({
      oauthAccount: { emailAddress: "not read" },
      projects: { "/elsewhere": { mcpServers: { local: { command: "never" } } } },
      mcpServers: { user: { type: "stdio", command: "user-server" }, remote: { type: "http", url: "https://example.com/mcp" } },
    }),
  });
  const loaded = loadMcp(home, folder, { env, claudeConfig });
  expect(loaded.servers.map((s) => [s.name, s.command, s.ask])).toEqual([
    ["user", "user-server", true],
    ["repo", "repo-server", true],
    ["shared", "verdandi-shared", true],
  ]);
  expect(loaded.project).toEqual(["repo"]);
  expect(loaded.trust).toEqual([expect.stringMatching(/^repo: repo-server with MODE set \(sha256 [0-9a-f]{16}\) \(\.mcp\.json\)$/)]);
  expect(loaded.notices).toEqual([expect.stringContaining("left out the MCP server remote")]);

  // Without the flag, Claude Code's files aren't read at all.
  const { home: plain, folder: other } = setup({ mcpJson: "{ not json", claude: "{ not json" });
  expect(loadMcp(plain, other, { env, claudeConfig: join(plain, "claude.json") }).servers).toEqual([]);
});

test("a broken file fails naming the file and key, never a value; a server naming an unset variable is left out", () => {
  const broken = (files: Parameters<typeof setup>[0]) => {
    const { home, folder, claudeConfig } = setup(files);
    try {
      loadMcp(home, folder, { env, claudeConfig });
    } catch (e) {
      return String(e);
    }
    return "loaded";
  };
  expect(broken({ home: "servers:\n  github: { command: npx, env: { TOKEN: 12345 } }\n" })).toContain(
    "mcp.yaml: servers.github.env must map names to strings.",
  );
  expect(broken({ home: "servers:\n  github: { command: npx, env: { TOKEN: 12345 } }\n" })).not.toContain("12345");
  expect(broken({ project: "importClaudeCode: true\n" })).toContain("importClaudeCode isn't a key this file takes");
  expect(broken({ home: "importClaudeCode: true\n", claude: '{"mcpServers": {"x": secret-token}}' })).toContain(
    "claude.json: isn't valid JSON.",
  );
  expect(broken({ home: "importClaudeCode: true\n", claude: '{"mcpServers": {"x": secret-token}}' })).not.toContain("secret");

  const { home, folder } = setup({ home: `servers:\n  needs: { command: x, env: { KEY: '\${MISSING_KEY}' } }\n` });
  const loaded = loadMcp(home, folder, { env });
  expect(loaded.servers).toEqual([]);
  expect(loaded.notices).toEqual([expect.stringContaining(`\${MISSING_KEY}, which isn't set`)]);
});
