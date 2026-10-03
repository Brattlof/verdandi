import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import type { ServerWebSocket, WebSocketHandler } from "bun";

/**
 * A private or loopback address: RFC 1918, link-local, loopback, Tailscale's tailnet (100.64.0.0/10, the shared
 * address space it hands out), and IPv6's unique-local (which holds Tailscale's fd7a:115c:a1e0::/48) and link-local ranges.
 */
export const isLocalAddress = (address: string) => {
  const ip = address.toLowerCase().replace(/^::ffff:(?=\d+\.)/, ""); // an IPv4 client on an IPv6 socket
  if (isIP(ip) === 4) {
    const [a = -1, b = -1] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIP(ip) === 6) return ip === "::1" || /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
  return false;
};

/**
 * Why `--host <host>` can't be used, or undefined when it can: every interface (`0.0.0.0`, `::`), or one
 * address on this machine's local network or tailnet. A public address is refused, so the web UI is never offered to the internet.
 */
export const hostProblem = (host: string) => {
  if (!isIP(host))
    return `--host takes an IP address, e.g. --host 0.0.0.0 for every interface or --host 192.168.1.20 for one; not "${host}".`;
  if (host === "0.0.0.0" || host === "::" || isLocalAddress(host)) return undefined;
  return `--host ${host} is a public address, and the web UI only listens on your local network or tailnet. Use 0.0.0.0, or this machine's address on your network (10.x, 172.16–31.x, 192.168.x, or Tailscale's 100.x).`;
};

/**
 * Whether a page at `origin` was served by the gate: at an address the gate listens on (any of this machine's,
 * for `0.0.0.0` or `::`), at its port. A hostname never is, so a DNS-rebound page is refused with any other site.
 */
export const gateOrigin = (origin: string, host: string, port: number) => {
  if (!URL.canParse(origin)) return false;
  const page = new URL(origin);
  const address = page.hostname.replace(/^[(.*)]$/, "$1");
  const own =
    host === "0.0.0.0" || host === "::"
      ? Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((a) => a.address.toLowerCase()))
      : [host.toLowerCase()];
  return page.protocol === "http:" && isIP(address) !== 0 && own.includes(address) && page.port === String(port);
};

/** A client WebSocket relayed to `upstream`, holding what the client sent before `upstream` opened. */
export type Relay = { readonly upstream: WebSocket; readonly pending: (string | Buffer)[] };

/**
 * Opens the upstream side of a relayed WebSocket, sending `headers`. Bun's client sends no `Origin`, so the side it
 * reaches sees none.
 */
export const relayTo = (url: string, headers: Record<string, string> = {}): Relay => {
  // Bun's WebSocket takes headers in its second argument, which the DOM typing (this package also types the page) lacks.
  const upstream = new WebSocket(url, { headers } as unknown as string[]);
  upstream.binaryType = "arraybuffer";
  return { upstream, pending: [] };
};

/** Pipes each relayed WebSocket both ways, as the agent's own limit allows: a turn's attachments arrive in one message. */
export const relaySockets: WebSocketHandler<Relay> = {
  maxPayloadLength: 20 * 1024 * 1024,
  open(ws: ServerWebSocket<Relay>) {
    const { upstream, pending } = ws.data;
    upstream.onmessage = (e) => ws.send(e.data as string | ArrayBuffer);
    upstream.onclose = () => ws.close();
    upstream.onerror = () => ws.close();
    // Messages the client sent before the upstream side opened go first, in order.
    upstream.onopen = () => {
      // A Bun Buffer is a Uint8Array over an ArrayBuffer, which the DOM typing of send (this package also types the page) misses.
      for (const m of pending.splice(0)) upstream.send(m as string | Uint8Array<ArrayBuffer>);
    };
  },
  message(ws, message) {
    const { upstream, pending } = ws.data;
    if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
    else pending.push(message);
  },
  close(ws) {
    ws.data.upstream.close();
  },
};

/** Headers only the gate sets on what it relays: the client's address, and the secret that proves the gate set it. */
export const gateHeaders = { client: "x-verdandi-client", secret: "x-verdandi-gate" } as const;

/**
 * Opens the web server (on `127.0.0.1:target`) to the local network or tailnet at `host:port`. Every request, the
 * page's files included, is refused unless it comes from a private, tailnet or loopback address (`allowed`), so even
 * with a public interface or a port forward the internet reaches nothing: a second line of defence, since devices pair
 * (ADR 0028). The page token `verdandi web` makes is refused here (`?token=`, `Authorization: Bearer`), so only paired
 * devices and pairing requests get through. The rest is relayed as is, WebSockets too, with the client's address and
 * `secret` (`gateHeaders`), which the web server trusts the address on. A WebSocket from a page the gate didn't serve
 * (`gateOrigin`) is refused before it reaches the web server, which can't check it itself: the relay sends no `Origin`.
 */
export const startLanGate = (host: string, port: number, target: number, secret: string, allowed = isLocalAddress) =>
  Bun.serve<Relay>({
    hostname: host,
    port,
    fetch(request, server) {
      const from = server.requestIP(request)?.address;
      if (!from || !allowed(from)) return new Response("Verdandi only answers on its local network.", { status: 403 });
      const url = new URL(request.url);
      if (url.searchParams.has("token") || request.headers.get("authorization")?.startsWith("Bearer "))
        return new Response(
          "That token only works on the machine running verdandi web. Open this address without it to pair this device.",
          { status: 403 },
        );
      const upstreamUrl = `http://127.0.0.1:${target}${url.pathname}${url.search}`;
      const relayed = { [gateHeaders.client]: from, [gateHeaders.secret]: secret };
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const origin = request.headers.get("origin");
        if (origin !== null && !gateOrigin(origin, host, server.port ?? port))
          return new Response(`Refused a connection from a page at ${origin}: only the web UI this gate serves may connect.`, {
            status: 403,
          });
        const userAgent = request.headers.get("user-agent");
        return server.upgrade(request, {
          data: relayTo(upstreamUrl.replace(/^http/, "ws"), { ...relayed, ...(userAgent && { "user-agent": userAgent }) }),
        })
          ? undefined
          : new Response("WebSocket upgrade failed.", { status: 400 });
      }
      const headers = new Headers(request.headers);
      for (const [name, value] of Object.entries(relayed)) headers.set(name, value);
      return fetch(upstreamUrl, { method: request.method, headers, body: request.body, redirect: "manual" });
    },
    websocket: relaySockets,
  });
