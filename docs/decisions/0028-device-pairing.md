# 0028 · Each device pairs and gets its own revocable token

## Status

Accepted (issue #215, 2026-10-03). Amends ADR 0025's network boundaries (its sections 2 and 3) and ADR 0026's LAN access.

## Context

verdandid made one token at each start, and `verdandi web` one page token per run. `verdandi web --host` printed a URL holding the page token for other devices, so every device shared one token, nothing listed who held it, and the only way to cut off one device was a restart, which cut off all of them. Bare `verdandi` now starts verdandid whenever none runs, so the token changes often and open tabs lose access with it. M5's exit criterion is approving tasks from a phone, and the remote agent (ADR 0026) needs a credential that never crosses a network as the profile's token.

The owner decided three questions:

1. **Who skips pairing:** whoever holds a token they were handed on this machine, never whoever connects from a loopback address. A reverse proxy on the same machine (`tailscale serve`, for the remote access DESIGN §15 plans) makes remote clients look like loopback, so the address can't be the exemption.
2. **The desktop app on the same machine** runs the agent binary as the user, so it reads the profile's token from `server.json` as the CLI does. It pairs like any device only when it connects to a remote agent.
3. **The API-only remote listener** and its protocol version check ship separately, on top of pairing.

## Decision

1. **Three credentials, each checked only as itself.** The profile's token (`server.json`: the CLI, the desktop app locally, `verdandi web`'s relay) as `?token=` or `Authorization: Bearer`. `verdandi web`'s page token, made per run and handed to the browser it opens in the URL fragment; the web server swaps it for the profile's. And a device token, as `?device=` or `Authorization: Device`, which verdandid checks against the paired devices. A relay that passes device tokens through can't pass the profile's, since a device token is never read as one.
2. **Pairing.** A client with none of them opens verdandid's `/pair` WebSocket (through `verdandi web` and the LAN gate for a browser). verdandid raises a pairing request with a 6-digit code, the device's name from its user agent, and the address the relay reports, and sends the code back. At most 3 wait; a 4th is refused. Requests live in verdandid's memory, never the log, so a client that hasn't paired can't write events; closing the socket withdraws one, and a restart drops them all. The owner approves or denies it from a client that has access: the web UI's Devices page (and a banner on every other page), a notice in the terminal chat, or `verdandi devices approve|deny <id>`. The code is the check: the address and name are hints a local process could fake.
3. **Tokens.** Approving makes 32 random bytes in verdandid, records `device.paired` (id, name, the token's SHA-256) on the profile's stream, and sends the token once, over the requester's own socket. No token is ever stored or logged; a device token survives verdandid's restarts. The page keeps it in `localStorage`.
4. **Revocation.** `device.revoke` records `device.revoked`; from then on the token opens nothing, and a reaction closes the device's open connections at once. `verdandi devices list|revoke` and the Devices page show each device with when it was last seen (`device_seen`, written on connect: process state, not a read model, since an event per connection would flood the log).
5. **The LAN gate** refuses the page token (`?token=` and `Authorization: Bearer`), so every other device pairs, and `--host` no longer prints a token URL. Its address check stays as a second line of defence. It tells the web server the client's address with a header only it can set, proven by a secret the two share in one process.

## Consequences

- A browser on another device pairs once and keeps working across restarts of verdandid and `verdandi web`; a tab on this machine whose page token went stale pairs too, rather than dying.
- Revoking one device leaves the others, and the profile's token, alone.
- The device token still travels over plain HTTP on the local network; Tailscale is the way beyond a network you trust.
- Unpaired clients can hold up to 3 request slots open. The owner denies them; a busier attack would need rate limits, which can come with the remote listener.
- The server tests for this are `apps/agent/src/devices/devices.test.ts` (pairing, restart, revocation, no token in the log) and `apps/agent/src/cli/web.test.ts` (a LAN client through the gate).
