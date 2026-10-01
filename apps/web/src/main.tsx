import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { connect } from "./client.ts";
import { RuneMark } from "./runes.tsx";

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
    <div className="grid h-dvh place-items-center p-6">
      <div className="max-w-sm border border-line bg-card px-6 py-5">
        <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold">
          <RuneMark className="size-7" />
          Verdandi
        </h1>
        <p className="mt-2 text-muted">
          Open Verdandi with <code>verdandi open</code>: it passes this page the token it needs.
        </p>
      </div>
    </div>
  ),
);
