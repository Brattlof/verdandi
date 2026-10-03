# Security

Verdandi runs coding agents on your machine, as you. Its trust model, meaning which layers are boundaries, which are heuristics and what isn't a vulnerability, is [ADR 0025](docs/decisions/0025-trust-model.md). Please read it before reporting.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting: the repository's **Security** tab, then **Report a vulnerability**. Please don't open a public issue, discussion or pull request for one.

Include the version (commit), your OS, the harness and access mode involved, the steps to reproduce, and what an attacker gains. `verdandi doctor` output helps; remove any paths you'd rather not share.

Verdandi has one maintainer. Expect an acknowledgement within 7 days, and a fix or a decision within 30 days of that.

## In scope

A bypass of a boundary in ADR 0025:

- running code or reading data as you without going through your OS account, for example from a web page, another device or another user on the machine;
- reaching verdandid's API without the profile's token, or from any browser page;
- reaching it through `verdandi web` without the page's token, or from a page on another site;
- the LAN gate (`verdandi web --host`) relaying a request from outside private, tailnet and loopback ranges, or a WebSocket from a page it didn't serve;
- input that passes validation at the RPC boundary and then escapes it: project paths, attachments, or skill paths outside the profile's skills folder;
- getting something past an ask Verdandi enforces: a project's verifiers or worktree setup running without the user trusting that exact list, a Verdandi tool that asks running unasked, or a skill change or memory save written without the approval it asked for.

## Out of scope

- Prompt injection that bypasses no boundary and no approval.
- Anything that needs your account or write access to the Verdandi home, or write access to a project folder, unless it gets the project's commands run past their ask.
- A bypass of the injection and secret scans, redaction, or "marked as data" fences. These are heuristics; we fix such bypasses as bugs.
- What an agent does after you approved it, or under permissions your own harness settings grant.
- Claude Code's own behaviour. Report it to Anthropic.
- `verdandi web --host` sending the page's token over plain HTTP on your local network. Use Tailscale beyond a network you trust.

## Security-sensitive code

| Area | Where |
|---|---|
| RPC socket, token and refusing browsers | `apps/agent/src/rpc/server.ts` |
| Web server: page token, relay and `Origin` check | `apps/web/src/serve.ts` |
| LAN gate | `apps/web/src/lan-gate.ts` |
| Process spawning and its environment | `apps/agent/src/home/child-env.ts`, `apps/agent/src/verifiers/verify.ts`, `apps/agent/src/terminals/` |
| Project paths and attachments | `apps/agent/src/projects/project.ts`, `apps/agent/src/attachments/attachments.ts` |
| Memory and skill writes | `apps/agent/src/memory/`, `apps/agent/src/skills/skill-files.ts` |
| Trusting a project's own commands (verifiers, worktree setup) | `apps/agent/src/trust/`, `apps/agent/src/event-store/reactor.ts` |
