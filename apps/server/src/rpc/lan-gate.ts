import { isIP } from "node:net";
import { networkInterfaces } from "node:os";

/** A private or loopback address: RFC 1918, link-local, loopback, and IPv6's unique-local and link-local ranges. */
export const isLocalAddress = (address: string) => {
  const ip = address.toLowerCase().replace(/^::ffff:(?=\d+\.)/, ""); // an IPv4 client on an IPv6 socket
  if (isIP(ip) === 4) {
    const [a = -1, b = -1] = ip.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIP(ip) === 6) return ip === "::1" || /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
  return false;
};

/**
 * Why `--host <host>` can't be used, or undefined when it can: every interface (`0.0.0.0`, `::`), or one
 * address on this machine's local network. A public address is refused, so verdandid is never offered to the internet.
 */
export const hostProblem = (host: string) => {
  if (!isIP(host))
    return `--host takes an IP address, e.g. --host 0.0.0.0 for every interface or --host 192.168.1.20 for one; not "${host}".`;
  if (host === "0.0.0.0" || host === "::" || isLocalAddress(host)) return undefined;
  return `--host ${host} is a public address, and verdandid only listens on your local network. Use 0.0.0.0, or this machine's address on your network (10.x, 172.16–31.x or 192.168.x).`;
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

type Relay = { readonly upstream: WebSocket; readonly pending: (string | Buffer)[] };

/**
 * Opens verdandid (on `127.0.0.1:target`) to the local network at `host:port`. Every request, the web UI's
 * files included, is refused unless it comes from a private or loopback address (`allowed`), so even with
 * a public interface or a port forward the internet reaches nothing; the rest is relayed as is, WebSockets
 * too. A WebSocket from a page the gate didn't serve (`gateOrigin`) is refused before it reaches verdandid, which
 * can't check it itself: the relay sends no `Origin`. The token still guards everything past the page. Returns the gate's server, to stop with verdandid.
 */
export const startLanGate = (host: string, port: number, target: number, allowed = isLocalAddress) =>
  Bun.serve<Relay>({
    hostname: host,
    port,
    fetch(request, server) {
      const from = server.requestIP(request)?.address;
      if (!from || !allowed(from)) return new Response("verdandid only answers on its local network.", { status: 403 });
      const url = new URL(request.url);
      const upstreamUrl = `http://127.0.0.1:${target}${url.pathname}${url.search}`;
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const origin = request.headers.get("origin");
        if (origin !== null && !gateOrigin(origin, host, server.port ?? port))
          return new Response(`Refused a connection from a page at ${origin}: only the web UI this gate serves may connect.`, {
            status: 403,
          });
        const upstream = new WebSocket(upstreamUrl.replace(/^http/, "ws"));
        upstream.binaryType = "arraybuffer";
        return server.upgrade(request, { data: { upstream, pending: [] } })
          ? undefined
          : new Response("WebSocket upgrade failed.", { status: 400 });
      }
      return fetch(upstreamUrl, { method: request.method, headers: request.headers, body: request.body, redirect: "manual" });
    },
    websocket: {
      // As verdandid's own limit: a turn's attachments arrive in one message.
      maxPayloadLength: 20 * 1024 * 1024,
      open(ws) {
        const { upstream, pending } = ws.data;
        upstream.onmessage = (e) => ws.send(e.data as string | ArrayBuffer);
        upstream.onclose = () => ws.close();
        upstream.onerror = () => ws.close();
        // Messages the client sent before verdandid's side opened go first, in order.
        upstream.onopen = () => {
          for (const m of pending.splice(0)) upstream.send(m);
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
    },
  });
