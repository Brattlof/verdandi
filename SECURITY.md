# Security

Verdandi runs coding agents on your machine, as you. Its trust model, meaning which layers are boundaries, which are heuristics and what isn't a vulnerability, is [ADR 0025](docs/decisions/0025-trust-model.md). Please read it before reporting.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting: the repository's **Security** tab, then **Report a vulnerability**. Please don't open a public issue, discussion or pull request for one.

Include the version (commit), your OS, the harness and access mode involved, the steps to reproduce, and what an attacker gains. `verdandi doctor` output helps; remove any paths you'd rather not share.

Verdandi has one maintainer. Expect an acknowledgement within 7 days, and a fix or a decision within 30 days of that.

## In scope

A bypass of a boundary in ADR 0025:

- running code or reading data as you without going through your OS account, for example from a web page, another device or another user on the machine;
- reaching verdandid's API without the profile's token, or from a page on another site;
- the LAN gate (`--host`) relaying a request from outside private and loopback ranges, or a WebSocket from a page it didn't serve;
- input that passes validation at the RPC boundary and then escapes it: project paths, attachments, or skill paths outside the profile's skills folder.

## Out of scope

- Prompt injection that bypasses no boundary and no approval.
- Anything that needs your account, or write access to the Verdandi home or a project folder.
- A bypass of the injection and secret scans, redaction, or "marked as data" fences. These are heuristics; we fix such bypasses as bugs.
- What an agent does after you approved it, or under permissions your own harness settings grant.
- Claude Code's own behaviour. Report it to Anthropic.
- `--host` sending the token over plain HTTP on your local network. Use Tailscale beyond a network you trust.

## Security-sensitive code

| Area | Where |
|---|---|
| RPC socket, token and `Origin` check | `apps/server/src/rpc/server.ts` |
| LAN gate | `apps/server/src/rpc/lan-gate.ts` |
| Process spawning and its environment | `apps/server/src/home/child-env.ts`, `apps/server/src/verifiers/verify.ts`, `apps/server/src/terminals/` |
| Project paths and attachments | `apps/server/src/projects/project.ts`, `apps/server/src/attachments/attachments.ts` |
| Memory and skill writes | `apps/server/src/memory/`, `apps/server/src/skills/skill-files.ts` |
| A project's own commands (verifiers, worktree setup) | `.verdandi/` in each project; asking before they run is #230 |
