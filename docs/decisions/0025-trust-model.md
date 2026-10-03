# 0025 · Verdandi's trust model

## Status

Accepted (issue #197, 2026-10-03). Describes the code as of #235 (secrets kept from child processes), #236 (`Origin` checks) and #242 (trusted project commands). Amended by ADR 0026: verdandid serves no web page and refuses every browser, `verdandi web` serves the UI with a page token of its own and checks the page's `Origin`, and the LAN gate moved to it (`apps/web/src/lan-gate.ts`) and counts Tailscale's range as local.

## Context

Verdandi's security layers differ widely in strength, and DESIGN §17 listed them side by side: the token, the LAN gate, injection scans ("a hit is refused"), approvals and plugins. A user or reporter could take the injection question for a boundary, but it's pattern rules that a reworded instruction gets past (the `ponytail` on `INSTRUCTIONS` in `packages/decisions/src/rules.ts`). Both rivals wrote down which of their layers are boundaries after their incidents. Hermes says "Nothing inside the agent process constitutes containment" and puts approval, redaction and scanner bypasses out of scope ([SECURITY.md](https://github.com/NousResearch/hermes-agent/blob/009afb3/SECURITY.md)). OpenClaw's out-of-scope list keeps its triage cheap ([SECURITY.md](https://github.com/openclaw/openclaw/blob/d0f7dcc/SECURITY.md)).

## Decision

### Boundaries

A bypass of one of these is a vulnerability.

1. **The OS user account.** verdandid, every harness, and every tool, verifier, setup command and terminal run as the user who started verdandid, with that user's rights. The Verdandi home and the project folders are trusted local state: whatever can write to them already acts as the user. The one exception is a project's own commands, which a cloned repo's author or an agent allowed only to edit files can write; they pass a consent gate (boundary 5). Nothing inside the agent process contains a hostile model; only the OS can, and Verdandi has no sandbox before M6.
2. **The loopback socket and the profile token.**
   - verdandid listens only on `127.0.0.1` (`ServerLayer` in `apps/agent/src/rpc/server.ts`).
   - An `/rpc` upgrade needs the token: 32 random bytes made at each start, compared in constant time (`sameToken`).
   - Before the token is read, an upgrade from any browser page is refused (ADR 0026; it allowed verdandid's own page until then). The CLI and `verdandi web`'s relay send no `Origin`. The web server checks its own page's `Origin` (`ownOrigin` in `apps/web/src/serve.ts`) and its own page token.
   - `/attachments/<id>` takes the token only in an `Authorization` header, which forces a CORS preflight that verdandid never grants.
   - The token is written to `server.json` in the home with mode `0600` (`apps/agent/src/main.ts`). On Windows the mode doesn't apply, and the file inherits the ACL of a home under the user's profile.
   - Per-device tokens are #215.
   - Bun's HMR socket (`/_bun/hmr`) exists only when `verdandi web` runs from source (verdandid's until ADR 0026), and it takes no token. Bun refuses a foreign hostname in its `Origin` but accepts `localhost` at any port. It sends a version string, the web UI's bundled source and reload notices, never the token or user data. A release build (`NODE_ENV=production`) has no such socket.
3. **The LAN gate.** With `verdandi web --host`, `startLanGate` (`apps/web/src/lan-gate.ts`) refuses:
   - every request that isn't from a private, tailnet or loopback address (`isLocalAddress`);
   - every WebSocket from a page it didn't serve (`gateOrigin`).

   A public `--host` address is refused (`hostProblem`). The token still guards everything past the page.
4. **Validation at the RPC boundary.**
   - Project paths must be existing folders, stored as their real paths (`resolveProjectPath` in `apps/agent/src/projects/project.ts`).
   - Attachments are counted and sized, and an image's bytes must match its type, before anything is stored (`storeAttachments` in `apps/agent/src/attachments/attachments.ts`).
   - A skill change must stay inside one kebab-case skill in the profile's folder, with no link on the way and no overlap with an extra folder (`prepareChange` in `apps/agent/src/skills/skill-files.ts`).
5. **The asks Verdandi itself enforces.** Nothing runs or is written past one of these without the user's answer:
   - a project's own commands (its verifiers in `.verdandi/routing.yaml`, its worktree setup in `.verdandi/worktree.yaml`) run only once the user trusts that exact list in the project, by its hash (`apps/agent/src/trust/trust.ts`), and a changed list asks again. Unattended runs only run trusted lists;
   - a Verdandi tool marked `ask` (`packages/tools`) runs only once allowed;
   - a native `terminal` command runs only once allowed, every one (`runTool` in `packages/harness-native/src/adapter.ts`);
   - a skill change, or a memory save or proposal that asks, writes nothing until allowed.

   Getting one of these past its ask is a vulnerability. What the approved step then does is not: an approval is consent, not containment.

### Heuristics

These lower risk, and they can be bypassed by design. A bypass is a bug worth fixing, not a vulnerability.

- The injection question (`untrusted.injection`, `injectionRules` in `packages/decisions/src/rules.ts`), the secret scans on memory (`scanMemory`) and skills (`scanSkill`), and trajectory redaction (`packages/trajectories/src/redact.ts`).
- "Marked as data" fences around untrusted text handed to the agent (escalation hand-offs, the review digest, the memory snapshot's entries: `asData` in `apps/agent/src/trust/fence.ts`, a fence longer than any run of backticks in the text, so the text can't close it), attachments handed over as paths marked as data, and the warning over a flagged search result. A model can still follow what's inside one.
- Background review's prompt rules on what never to capture, and its gate that offers skills only from a task whose last verifier run passed or that the user rated up (`skillsRefused` in `apps/agent/src/review/review.ts`). A passing verifier doesn't make a lesson true.
- What an approval or plan mode limits. They're consent, not containment: they ask before a step, and don't limit what an approved step does or what the user's own harness settings already allow. The harness's own permission prompts and plan mode (Claude Code's read-only mode) are enforced by the harness.
- The native harness's file tools' path rules (`access` in `packages/harness-native/src/file-tools.ts`): free in the thread's folder and the `workspace.yaml` folders, asking elsewhere, refusing the rest of the Verdandi home. They steer the agent's own tools, but anything run as the user, Claude Code's tools included, reaches the same files.
- Spend caps (`spend-caps.yaml`) and task limits, which are a budget, not a security control.
- Skill pins (`skill_pins`). The decider refuses a pinned skill's change on Verdandi's own path (`skill_manage`, a background review's proposal) and curation leaves it alone, but a harness's own file tools that the user allows can still write the skills folder.

### Out of scope as vulnerabilities

- Prompt injection that bypasses no boundary and no approval.
- Anything that needs the user's account or write access to the home. The same goes for write access to a project folder, unless it gets the project's commands run past their ask.
- A bypass of a scanner, a fence or redaction.
- What an agent does after the user approved it, or under permissions the user's own harness settings grant.
- Claude Code's own behaviour, which is Anthropic's to fix.
- `--host` sending the token over plain HTTP on the local network. Beyond a network you trust, don't use `--host`; use Tailscale (DESIGN §15).

### Principals

Today the only principal is the owner: the OS user, who holds the token. Once the gateway exists (DESIGN §15) there will be:

- **The owner:** the OS user, holding the token (per device after #215).
- **Allowlisted channel senders:** they can start turns in their bound thread and never run owner commands (#212).
- **Scheduled jobs:** they run as the owner, under a restricted profile and a budget.
- **The agent:** never a principal. It acts for one, inside that principal's approvals.

Tool outputs, gateway messages, memory entries, skill files and web pages stay data, never instructions (AGENTS.md's invariants).

### Defaults

The rivals' incidents argue for these defaults. Each one names what holds it today.

1. **No borrowed credentials.** Verdandi never reads or refreshes another program's login: the Claude Code adapter drives the user's own logged-in CLI (`packages/harness-claude-code/src/adapter.ts`). Verdandi's own secrets never reach a process it starts:
   - `secretVariables` (`packages/harness-native/src/key.ts`) are left out of `childEnv()` (`apps/agent/src/home/child-env.ts`), which every spawn passes;
   - `nativeHarness` takes the key out of `process.env` once it has read it;
   - the PTY host starts with `--no-env-file`.

   This is hygiene, not a boundary: an agent running as you can read any file you can, so a key in `.env` is only as private as that file, and the keychain is the better home for it.
2. **No default outbound calls.** verdandid calls only the user's harness and the providers they configured. The native harness's client has a fixed base URL (`https://api.anthropic.com`, `packages/harness-native/src/adapter.ts`) and runs only with a key. There is no telemetry. The web UI bundles its fonts (`@fontsource-variable`, `apps/web/src/styles.css`) and shows remote Markdown images as text (`apps/web/src/ui/markdown.tsx`). Anything more must be named in config and stays off until turned on.
3. **Consent first for self-improvement.**
   - A skill change is a `skill.proposed` request with a diff, and nothing is written until the user allows it (`apps/agent/src/skills/`).
   - Background review is off unless `review.yaml` sets `enabled: true`, and each of its proposals is a pending request.
   - Memory saves ask too: `approveSaves` now defaults to `true` (`apps/agent/src/memory/memory-config.ts`). This turns ADR 0016's opt-in into an opt-out, and `approveSaves: false` in `memory.yaml` restores the old behaviour. The user's own saves from the Memory tab don't ask.
4. **No full-context heartbeats.** Background model work runs on a digest (`apps/agent/src/review/review.ts`), as a routed task with a cost cap: `aux.review` at `maxCost` 0.25 in `packages/router/src/policy.json`. It never spends metered dollars unless `review.yaml` sets `allowMetered: true` (ADR 0023).
5. **No open code marketplace.** Skills come only from the profile's folder and the read-only `extraFolders` named in `skills.yaml`, and the agent changes them only through the approval diff. No plugin exists yet. DESIGN §17 and §18 require content-only bundles first, code only out of process, pinned installs, and consent bound to a hash of the declared capabilities. Hub skills will install pinned to a commit, through the same proposal flow (#218).

`SECURITY.md` points here and says how to report a vulnerability.

## Consequences

- A report is triaged against the boundaries above. A heuristic's weakness is fixed as a bug, and no doc may present a heuristic as a boundary.
- Containment comes from the OS (a separate account, a VM or a container) until M6's sandbox, and the docs say so rather than imply otherwise.
- With `approveSaves` on by default, `memory_save` raises an approval on Claude Code and the native harness in every home without a `memory.yaml`. A headless `verdandi run` whose agent saves a memory therefore stops at it (exit code 5), unless `--deny-requests` is set or the home sets `approveSaves: false`.
- Known gaps, tracked: one token for every device (#215); context files and skills that Claude Code loads by itself aren't scanned (#177).
