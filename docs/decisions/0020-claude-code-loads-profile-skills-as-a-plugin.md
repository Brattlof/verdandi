# 0020 · Claude Code loads the profile's skills as a local plugin

## Status

Accepted (issue #129, 2026-10-02).

## Context

DESIGN §14.4 keeps a profile's skills in `<home>/skills/` (the Verdandi home is the profile folder, `~/.verdandi/profiles/<p>`), in the Agent Skills `SKILL.md` format, and wants Claude Code to pick them up natively. Claude Code finds skills in `~/.claude/skills`, `<project>/.claude/skills` and plugins; neither folder is the profile's, and an extra skills folder has no option of its own in Agent SDK 0.3.272.

The SDK's `plugins: [{ type: "local", path, skipMcpDiscovery }]` (one `--plugin-dir` per entry) loads a plugin folder's `skills/*/SKILL.md`. Read from the bundled CLI's source: a plugin's default `skills/` folder is always loaded when it exists; its `commands/`, `agents/`, `hooks/`, `output-styles/`, `themes/`, `workflows/`, `monitors/` and `settings.json` load too when present; `skipMcpDiscovery` skips its `.mcp.json`; a manifest's own `skills` paths must stay inside the plugin folder. A spike (no prompt sent, `supportedCommands()` only, CLI 2.1.287) confirmed that a home passed as a plugin lists `<home>/skills/deploy-notes` as `<plugin>:deploy-notes`, the plugin named after its folder, or `verdandi` with `.claude-plugin/plugin.json` saying so.

## Decision

1. verdandid makes its home a plugin when it starts: it creates `<home>/skills/` and writes `<home>/.claude-plugin/plugin.json` (`{ "name": "verdandi" }`), and the Claude Code adapter passes the home in `plugins` with `skipMcpDiscovery: true` (Verdandi serves its own MCP server, ADR 0005). Skills show to the agent as `verdandi:<name>`.
2. It is set at spawn, like the tool list, and never changes during a session. A skill written mid-session is on disk at once; whether that session's skill list picks it up is Claude Code's business, and Verdandi promises only new sessions.
3. The home's top-level folders belong to Verdandi, and none may be named like a plugin component (`commands`, `agents`, `hooks`, `output-styles`, `themes`, `workflows`, `monitors`, or a `settings.json` file), or Claude Code would load it into every session. The agent writes only under `<home>/skills/<name>/`, through `skill_manage` and the user's approval.
4. Read-only extra folders (`extraFolders` in the home's `skills.yaml`) are listed in the Skills panel and `verdandi skills list`, but not loaded into Claude Code: a plugin folder is the skills folder's parent, whose other components would load too. Claude Code already loads `~/.claude/skills` itself.
5. Other harnesses: the fake harness has no model and loads nothing. The native harness (ADR 0022) doesn't load skills yet; it will use the skills index and `skill_view` (DESIGN §14.4). `skill_manage` is a Verdandi tool, so every harness gets it.
6. `skill_manage` doesn't use the harness's own approval (`ask`): it waits inside the tool call for a request Verdandi raises itself (`skill.proposed`), so the scan runs and the diff is recorded before the user is asked. Claude Code gives an in-process MCP server's call no idle timeout and a 1e8 ms (about 28 hours) hard one (`MCP_TOOL_TIMEOUT`), and doesn't move a non-interactive (SDK) session's MCP calls to the background, so the call can wait as long as an approval.

## Consequences

- Skills in the profile are in every Claude Code session's skill list, costing their descriptions' tokens, cached like the rest of the prompt.
- A future Verdandi folder in the home with a component's name would leak into Claude Code; this ADR is where that's written down.
- Loading extra folders into Claude Code needs another way in: a generated plugin folder per extra folder, or an SDK option for skill folders if one appears.
- A CLI too old for `--plugin-dir-no-mcp` (what `skipMcpDiscovery` becomes) fails to start; 2.1.287 and the bundled CLI have it.
