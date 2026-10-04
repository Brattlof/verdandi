<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.png">
    <img src="docs/assets/banner.png" alt="Verdandi" width="100%">
  </picture>
</p>

# Verdandi

<p align="center">
  <img src="https://img.shields.io/badge/Status-pre--alpha-1B1A18?style=for-the-badge" alt="Status: pre-alpha">
  <img src="https://img.shields.io/badge/Runtime-Bun-000000?style=for-the-badge&logo=bun&logoColor=white" alt="Runtime: Bun">
  <img src="https://img.shields.io/badge/Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-first--class-5C5953?style=for-the-badge" alt="Windows, macOS and Linux">
</p>

**A local-first workspace for coding agents that sends each task to the cheapest model that can finish it.** A commit message doesn't need Opus at `xhigh`, and a subtle concurrency bug shouldn't go to a small model. Verdandi drives the harnesses you already use, starting with Claude Code, picks a model and effort level for every task, tells you why in one line, and escalates when a check fails.

Everything lives on your machine. Nothing leaves it except calls to the providers you've configured.

<table>
<tr><td><b>Routes every task</b></td><td>Weighs subscription quota, API credits and local compute, switches only at task boundaries so prompt caches survive, and steps up when a verifier fails. Policy is a plain <code>.verdandi/routing.yaml</code> you can diff. Overriding it takes one click.</td></tr>
<tr><td><b>Built on the harnesses you use</b></td><td>Runs your installed, logged-in Claude Code on your subscription, with its skills, hooks, MCP and plan mode intact. Verdandi's own agent loop runs on the Anthropic API with your key, and a thread can switch between the two mid-conversation.</td></tr>
<tr><td><b>Terminal first</b></td><td>Type <code>verdandi</code> in any project. A web UI adds threads side by side, diffs, approvals, worktrees, checkpoints you can revert to, and a real terminal.</td></tr>
<tr><td><b>Remembers and learns</b></td><td>Memory and session search across threads, skills it proposes and you approve, and a record of every task's route, outcome and cost.</td></tr>
</table>

> [!NOTE]
> Verdandi is pre-alpha and runs from source only. See the [milestones](docs/DESIGN.md#21-milestones) for what's built and what's next.

## Quick start

You need [Bun](https://bun.sh) 1.4.2 or newer and a logged-in [Claude Code](https://claude.com/claude-code).

```bash
git clone https://github.com/Brattlof/verdandi.git
cd verdandi
bun install

bun run verdandi --home ./.verdandi-dev          # chat in the terminal
bun run web:dev                                  # or open the web UI
bun run verdandi doctor --home ./.verdandi-dev   # check your setup
```

`--home` keeps a throwaway profile in the repo. Without it, Verdandi uses `~/.verdandi/profiles/default`. Run `bun run verdandi help` for every command.

## How it fits together

- **verdandid** is the local server. Every command is saved as an event before anything happens, so routing decisions, overrides and spend can all be inspected afterwards.
- **Harnesses** run the agent loop: Claude Code and Verdandi's own loop today, others later.
- **The router** picks a harness, model and effort level for each task and explains the choice. See [DESIGN.md §8](docs/DESIGN.md#8-task-based-routing).
- **Clients**, the terminal chat, the web UI and headless `verdandi run`, talk to verdandid over a WebSocket on `127.0.0.1`.

## Documentation

| Document | What's covered |
| --- | --- |
| [Design](docs/DESIGN.md) | Scope, architecture, routing, security, milestones. The source of truth. |
| [Decisions](docs/decisions) | Architecture decision records. |
| [AGENTS.md](AGENTS.md) | How we build Verdandi. Read it before contributing, whether you're a person or an agent. |
| [Security](SECURITY.md) | The trust model, and how to report a vulnerability. |

## The name

**Verðandi** (ᚹᛖᚱᚦᚨᚾᛞᛁ) is the Norn of the present, one of the three who weave the threads of fate at the roots of Yggdrasil. Verdandi decides, right now, how much model the next task gets. Not too big, not too small.

## License

[Apache-2.0](LICENSE).
