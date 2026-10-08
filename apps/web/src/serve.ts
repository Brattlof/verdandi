import { randomBytes, timingSafeEqual } from "node:crypto";
import index from "../index.html";
import { gateHeaders, type Relay, relaySockets, relayTo } from "./lan-gate.ts";

/** Where the agent's API listens (its `server.json`): the web server relays to it on loopback with this token. */
export type Agent = { readonly port: number; readonly token: string };

/**
 * Whether a page at `origin` is this server's own UI: on loopback, at the port the request came in on (`host`).
 * DNS rebinding can point another site's hostname at 127.0.0.1, but its origin keeps that hostname.
 */
export const ownOrigin = (origin: string, host: string | null) => {
  if (!URL.canParse(origin) || !URL.canParse(`http://${host}`)) return false;
  const page = new URL(origin);
  return (
    page.protocol === "http:" &&
    (page.hostname === "127.0.0.1" || page.hostname === "localhost") &&
    page.port === new URL(`http://${host}`).port
  );
};

/**
 * `verdandi web`: serves the UI (`packages/ui`, through `index.html`) on 127.0.0.1 and relays its RPC WebSocket,
 * attachment fetches and pairing to the agent (ADR 0026, ADR 0028). The page `verdandi web` opens gets a token of this
 * server's own, swapped for the agent's on the way through, so the agent's token never reaches a browser; any other
 * page pairs, and its device token (`?device=`, `Authorization: Device`) goes through as is, for the agent to check.
 * `/auth` says whether a page's token still works, which a WebSocket can't. Run from source it rebuilds on every change
 * to the UI and reloads open pages; with `NODE_ENV=production` it builds one minified bundle on the first request.
 * `startLanGate`, given `gateSecret`, opens it to the local network.
 */
export const serveWeb = (agent: Agent, port = 0) => {
  const token = randomBytes(32).toString("hex");
  const gateSecret = randomBytes(32).toString("hex");
  const same = (given: string | null | undefined, secret: string) =>
    typeof given === "string" && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  const valid = (given: string | null | undefined) => same(given, token);
  const agentUrl = `127.0.0.1:${agent.port}`;
  const server = Bun.serve<Relay>({
    hostname: "127.0.0.1",
    port,
    routes: { "/": index },
    development: Bun.env.NODE_ENV === "production" ? false : { hmr: true },
    fetch(request, server) {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization") ?? "";
      const page = valid(authorization.replace(/^Bearer /, "")) || valid(url.searchParams.get("token"));
      const device = authorization.startsWith("Device ") || url.searchParams.has("device");
      if (url.pathname === "/rpc" || url.pathname === "/pair") {
        const origin = request.headers.get("origin");
        if (origin !== null && !ownOrigin(origin, request.headers.get("host")))
          return new Response(`Refused a connection from a page at ${origin}: only Verdandi's own web UI may connect.`, { status: 403 });
        // The address the gate relayed for, when it's the gate; else this socket's. Shown to the owner as a hint.
        const address = same(request.headers.get(gateHeaders.secret), gateSecret)
          ? (request.headers.get(gateHeaders.client) ?? "unknown")
          : (server.requestIP(request)?.address ?? "unknown");
        const upstream =
          url.pathname === "/pair"
            ? `ws://${agentUrl}/pair`
            : page
              ? `ws://${agentUrl}/rpc?token=${encodeURIComponent(agent.token)}`
              : device
                ? `ws://${agentUrl}/rpc?device=${encodeURIComponent(url.searchParams.get("device") ?? "")}`
                : undefined;
        if (!upstream)
          return new Response("Missing or wrong token. Open the web UI with verdandi web, or pair this device.", { status: 401 });
        const headers = { [gateHeaders.client]: address, "user-agent": request.headers.get("user-agent") ?? "" };
        return server.upgrade(request, { data: relayTo(upstream, url.pathname === "/pair" ? headers : {}) })
          ? undefined
          : new Response("WebSocket upgrade failed.", { status: 400 });
      }
      const forward = (path: string) =>
        page || device
          ? fetch(`http://${agentUrl}${path}`, { headers: { authorization: page ? `Bearer ${agent.token}` : authorization } })
          : new Response("Missing or wrong token.", { status: 401 });
      if (url.pathname === "/auth" && request.method === "GET") return page ? Response.json({ kind: "page" }) : forward("/auth");
      // A video project's preview: the id in its path is the capability (an iframe can't send a token), and verdandid
      // sandboxes every response, so it is relayed as is, Range and fetch metadata included, for media seeking.
      if (/^\/video\/[0-9a-f]{64}(?:\/|$)/.test(url.pathname) && request.method === "GET") {
        const headers = new Headers();
        for (const name of ["range", "accept", "sec-fetch-dest", "if-none-match"]) {
          const value = request.headers.get(name);
          if (value !== null) headers.set(name, value);
        }
        return fetch(`http://${agentUrl}${url.pathname}`, { headers });
      }
      const attachment = /^\/attachments\/([^/]+)$/.exec(url.pathname)?.[1];
      if (attachment !== undefined && request.method === "GET") return forward(`/attachments/${attachment}`);
      return new Response("Not found.", { status: 404 });
    },
    websocket: relaySockets,
  });
  return { port: server.port ?? port, token, gateSecret, stop: () => server.stop(true) };
};
