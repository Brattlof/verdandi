# 0026 · The agent serves no web page; the UI is a package its hosts share

## Status

Accepted (2026-10-03). Amends ADR 0025's network boundaries (its sections 2 and 3).

## Context

verdandid served the web UI at `/` on its own port, imported `@verdandi/web`, and let pages from its own address connect to its RPC. `verdandi start --host` opened all of that to the local network through the LAN gate, with the profile's token in a URL for other devices.

Verdandi is now terminal-first (DESIGN §11): most users chat in the terminal or from a messaging app, and never open a browser. For them a web server in the agent is attack surface they never use. The desktop app (M5) also needs the UI without depending on a web server, and must be able to reach an agent on another machine, e.g. one on a VM over Tailscale.

## Decision

1. **The agent serves no web page.** verdandid answers only its API on `127.0.0.1`: `/rpc` and `/attachments/<id>`, both behind the profile's token. It refuses every `/rpc` upgrade that carries an `Origin`, so no browser page reaches it directly, its own address included. `apps/agent` doesn't import the web UI: only the `verdandi web` command loads `apps/web`, on demand.
2. **The UI is a package, `packages/ui`.** It is the whole React app, imports only `@verdandi/contracts`, and exposes `mount(root, endpoint, missing)`. An `Endpoint` names where its host serves `/rpc` and attachments, the host's token for the page, whether the agent is on the machine showing it (`sameMachine`, for the OS folder dialog), and what to say when the connection is lost. Hosts are thin: they mount the UI and connect it; a UI change is made once.
3. **`apps/web` is one host: `verdandi web`.** It serves the page on `127.0.0.1` and relays `/rpc` and attachments to the agent. The page gets a token of the web server's own, swapped for the agent's on the way through, so the agent's token never reaches a browser. It checks the page's `Origin` as verdandid did. `verdandi web --host` opens it to the local network or tailnet through the LAN gate, which moved here from the agent and now also counts Tailscale's `100.64.0.0/10` as local. `verdandi open` and `verdandi start --host` are gone.
4. **`apps/desktop` (M5) is the other host.** Electron's main process runs the agent binary it ships, or connects to a remote one, holds the token, and renders `packages/ui` in its window; it never depends on `apps/web`.
5. **A remote agent (M5)** is reached through an API-only listener on a private or tailnet address, never a page, and needs three things first: per-device pairing and tokens (#215), a protocol version check when a client connects (the desktop app and a remote agent update separately), and a connection picker in the desktop app. Until then the agent listens on loopback only, and a browser on another device uses `verdandi web --host`.

## Consequences

- A default install opens one loopback port with an API and no page; nothing renders HTML unless `verdandi web` runs.
- A browser holds only the web server's token, made per run; stopping `verdandi web` revokes it. The agent's token stays in processes the user started.
- `verdandi web` is one more process, and it starts verdandid in its own process when none runs, like the terminal chat.
- Running from source, Bun reads `bunfig.toml` (the Tailwind plugin) from the current folder, so `verdandi web` from source needs the repo root as its folder; a compiled binary bundles the page at build time.
- The relay tests live in `apps/agent/src/cli/web.test.ts`, since the agent may import `apps/web` and never the reverse.
