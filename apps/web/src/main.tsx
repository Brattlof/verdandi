import { mount, pair } from "@verdandi/ui";

const tokenKey = "verdandi.token";
/** Kept across restarts of the browser, verdandid and the web server, until the device is revoked (ADR 0028). */
const deviceKey = "verdandi.device";

/**
 * `verdandi web` passes the page its token in the URL fragment, which never reaches server logs or a
 * `Referer` header. It moves into this tab's session storage and out of the address bar.
 */
const takeToken = () => {
  const params = new URLSearchParams(location.hash.slice(1));
  const fromUrl = params.get("token");
  if (fromUrl) {
    sessionStorage.setItem(tokenKey, fromUrl);
    params.delete("token");
    history.replaceState(null, "", `${location.pathname}${location.search}${params.size ? `#${params}` : ""}`);
  }
  return sessionStorage.getItem(tokenKey);
};

/** Whether the web server still takes `token`: a page token from an earlier run, or a revoked device's, doesn't. */
const works = async (token: string, device: boolean) => {
  const answer = await fetch("/auth", { headers: { authorization: `${device ? "Device" : "Bearer"} ${token}` } });
  return answer.ok;
};

const root = document.getElementById("root");
if (!root) throw new Error("index.html lost its #root element.");
const show = (token: string, device: boolean) =>
  mount(
    root,
    {
      base: location.origin,
      token,
      ...(device && { device }),
      // The web server runs beside the agent, so a page on loopback is on the agent's machine; one over --host isn't.
      sameMachine: ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname),
      reconnectHint: device
        ? "If verdandid or the web server restarted, reload. A revoked device pairs again."
        : "If verdandid or the web server restarted, run verdandi web again.",
    },
    "",
  );

try {
  const page = takeToken();
  const device = localStorage.getItem(deviceKey);
  if (page && (await works(page, false))) show(page, false);
  else if (device && (await works(device, true))) show(device, true);
  else {
    // Neither works: this device pairs, and keeps the token it gets.
    sessionStorage.removeItem(tokenKey);
    localStorage.removeItem(deviceKey);
    const token = await pair(root, location.origin);
    localStorage.setItem(deviceKey, token);
    show(token, true);
  }
} catch {
  mount(root, undefined, "Can't reach Verdandi's web server. Start it with verdandi web, then reload.");
}
