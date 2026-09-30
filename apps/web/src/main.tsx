import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { connect } from "./client.ts";

const tokenKey = "verdandi.token";

/**
 * `verdandi open` passes the token in the URL fragment, which never reaches server logs or a
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
createRoot(root).render(
  token ? (
    <App connection={connect(token)} />
  ) : (
    <p className="empty">
      Open Verdandi with <code>verdandi open</code>: it passes this page the token it needs.
    </p>
  ),
);
