import { randomBytes, timingSafeEqual } from "node:crypto";
import index from "../index.html";
import { type Relay, relaySockets, relayTo } from "./lan-gate.ts";

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
 * `verdandi web`: serves the UI (`packages/ui`, through `index.html`) on 127.0.0.1 and relays its RPC WebSocket and
 * attachment fetches to the agent (ADR 0026). The page gets a token of this server's own, which is swapped for the
 * agent's on the way through, so the agent's token never reaches a browser. Run from source it rebuilds on every
 * change to the UI and reloads open pages; with `NODE_ENV=production` it builds one minified bundle on the first
 * request. `startLanGate` opens it to the local network.
 */
export const serveWeb = (agent: Agent, port = 0) => {
  const token = randomBytes(32).toString("hex");
  const valid = (given: string | null | undefined) =>
    typeof given === "string" && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
  const server = Bun.serve<Relay>({
    hostname: "127.0.0.1",
    port,
    routes: { "/": index },
    development: Bun.env.NODE_ENV === "production" ? false : { hmr: true },
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/rpc") {
        const origin = request.headers.get("origin");
        if (origin !== null && !ownOrigin(origin, request.headers.get("host")))
          return new Response(`Refused a connection from a page at ${origin}: only Verdandi's own web UI may connect.`, { status: 403 });
        if (!valid(url.searchParams.get("token")))
          return new Response("Missing or wrong token. Open the web UI with verdandi web, which passes the page its token.", {
            status: 401,
          });
        const upstream = `ws://127.0.0.1:${agent.port}/rpc?token=${encodeURIComponent(agent.token)}`;
        return server.upgrade(request, { data: relayTo(upstream) })
          ? undefined
          : new Response("WebSocket upgrade failed.", { status: 400 });
      }
      const attachment = /^\/attachments\/([^/]+)$/.exec(url.pathname)?.[1];
      if (attachment !== undefined && request.method === "GET") {
        if (!valid(request.headers.get("authorization")?.replace(/^Bearer /, "")))
          return new Response("Missing or wrong token.", { status: 401 });
        return fetch(`http://127.0.0.1:${agent.port}/attachments/${attachment}`, {
          headers: { authorization: `Bearer ${agent.token}` },
        });
      }
      return new Response("Not found.", { status: 404 });
    },
    websocket: relaySockets,
  });
  return { port: server.port ?? port, token, stop: () => server.stop(true) };
};
