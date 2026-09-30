# 0014 · Claude Code subagents are routed by redefining them at session start

## Status

Accepted (spike, 2026-09-30).

## Context

Subagent routing is the lever that leaves the main thread's cache alone (DESIGN §8.2 lever 1). ADR 0005 chose the SDK's `agents` option, with a `model` per agent. What it didn't settle is how to reach the subagent the main agent already uses for exploration: Claude Code's built-in `Explore`. The policy names Verdandi's own profiles (`explorer`, `reviewer`, DESIGN §8.6), and each harness maps them to its own subagents.

A spike on Claude Code through Agent SDK 0.3.272 ran a Sonnet session that asked for the `Explore` subagent, three ways:
- with no `agents`: the subagent ran on Sonnet;
- with `agents.Explore` on `haiku`: it ran on Haiku;
- with `agents.Explore` on `opus`: it ran on Opus.

## Decision

1. The Claude Code adapter maps `explorer` to a definition named `Explore`, which replaces the built-in, and `reviewer` to a new agent named `reviewer`. Each gets Verdandi's own description, prompt and read-only tools, plus the routed `model` and `effort`.
2. `agents` is set only when a Claude Code process starts. A route without subagents leaves Claude Code's own agents alone.
3. A harness session keeps the subagents it started with. The router keeps a warm session's subagents, a pin keeps them on the same harness, and the policy's apply from the next fresh session.

## Consequences

- The built-in `Explore` inherits the main model. Sending it to Haiku saves the difference on every exploration an Opus or Sonnet task delegates.
- Routing `explorer` replaces Claude Code's own `Explore` prompt with Verdandi's. The built-in policy routes no subagents until outcomes show Verdandi's prompts do at least as well, so it's opt-in through `routing.yaml`.
- The agent list is part of the Agent tool's description, so it sits in the cached prompt. Keeping it fixed for a session keeps that cache. A process resumed after an interrupt or restart gets the same list back from the thread's route.
- Subagent usage lands in the usage ledger by model, as ADR 0005 found for `modelUsage`.
