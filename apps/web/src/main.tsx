import { mount } from "@verdandi/ui";

const tokenKey = "verdandi.token";

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

const root = document.getElementById("root");
if (!root) throw new Error("index.html lost its #root element.");
const token = takeToken();
mount(
  root,
  token
    ? {
        base: location.origin,
        token,
        // The web server runs beside the agent, so a page on loopback is on the agent's machine; one over --host isn't.
        sameMachine: ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname),
        reconnectHint: "If verdandid or the web server restarted, run verdandi web again.",
      }
    : undefined,
  "Open Verdandi with verdandi web: it passes this page the token it needs.",
);
