# 0001 · Drive Claude Code through the Agent SDK under Bun

## Status

Accepted (M0 spike 001, 2026-09-29).

## Context

DESIGN §9.3 plans to drive Claude Code through the Claude Agent SDK for TypeScript, pointing `pathToClaudeCodeExecutable` at the user's installed `claude`. The runtime is Bun (§19), and Windows is first-class. None of this had been run together.

Spike 001 ran `@anthropic-ai/claude-agent-sdk@0.3.272` under Bun 1.3.14 on Windows 11 against both the SDK's bundled CLI (2.1.272) and the installed CLI (2.1.284), on a subscription login.

## Decision

1. The Claude Code harness uses the Agent SDK under Bun, with `pathToClaudeCodeExecutable` set to the installed `claude`. The SDK's bundled binary is not the default.
2. Every session records `claude_code_version` from the `system/init` message.
3. The harness passes an identical tool and MCP configuration to every `query()` of a session, including resumes, with `settings: { disableClaudeAiConnectors: true }` so claude.ai connectors can't attach or detach between turns. The user's `.mcp.json`, user and plugin MCP servers still load. `strictMcpConfig` (which would drop those too) is not used.
4. The harness checks that `cwd` exists before spawning. A spawn `ENOENT` is reported as a missing cwd, not as the SDK's "binary failed to launch" message.

## Consequences

- Streaming, `session_id`, resume, `total_cost_usd` and per-model `modelUsage` (including cache and thinking tokens) work as documented; `rate_limit_event` arrives each turn on subscription. The usage ledger can be built on `modelUsage`.
- SDK and CLI versions can skew (12 releases worked). The SDK is pinned exactly; a CLI update can still change behaviour, so harness contract tests run against the installed CLI version.
- Unpinned, claude.ai connectors made the tool list differ between a fresh turn and its resume, which breaks the prompt cache. Pinning makes the list deterministic.
- claude.ai connectors are unavailable inside Goldiloop's Claude Code sessions. Whether the user's other MCP servers load deterministically was not tested; spike 001 only saw connectors flap.
- First-delta latency is about 2–3 s on the installed CLI, mostly process start. Long-lived streaming-input sessions (spikes 002–003) avoid paying it per turn.
