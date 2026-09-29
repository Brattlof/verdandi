# 0005 · Claude Code hooks, Goldiloop MCP tools, subagent usage and limits

## Status

Accepted (M0 spike 005, 2026-09-29).

## Context

DESIGN §9.3 plans SDK hooks for verifiers and task outcomes, Goldiloop tools over an MCP server inside goldiloopd, subagent routing through `agents`, and §8.3 / §8.9 plan quota-based pricing and budgets. Appendix D asked whether SDK hooks coexist with the user's hooks, whether an MCP server can be served in-process, how subagent usage shows in `modelUsage`, whether a dollar budget exists, and which quota signals subscription users get.

Spike 005 checked each on the installed Claude Code 2.1.284 through Agent SDK 0.3.272.

## Decision

1. Goldiloop's hooks are SDK hook callbacks. They run alongside hooks from the user's settings files.
2. Goldiloop tools are one in-process server from `createSdkMcpServer`, passed in `mcpServers`.
3. Subagent routing uses `agents` with a `model` per agent. The usage ledger records every `modelUsage` row, including Claude Code's auxiliary calls.
4. The per-task hard cap is `maxBudgetUsd`; `maxTurns` is the turn guard. The adapter expects an error result followed by a thrown error.
5. Quota state comes from `rate_limit_event` on each turn and from the usage control request, which can be read without a model call. When the plan window is exhausted and extra usage is enabled, the Claude Code target is priced as metered.

## Consequences

- The user's own hooks keep working, as §9.3 promises.
- The SDK MCP server connects even under `strictMcpConfig: true`, so Goldiloop's tools survive any MCP pinning (ADR 0001 uses the lighter `disableClaudeAiConnectors`).
- A subscription target can silently turn into paid extra usage when the weekly window is used up (observed during this spike). Goldiloop shows the switch and prices those turns as metered (DESIGN §8.9, open question 7).
- The usage control request is marked experimental in the SDK; the adapter wraps it and falls back to `rate_limit_event` alone if it disappears.
- `maxBudgetUsd` is checked after a call, so a task can exceed it by one call.
