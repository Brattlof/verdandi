import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { connect, type Endpoint } from "./client.ts";
import { RuneMark } from "./ui/runes.tsx";

export type { Endpoint } from "./client.ts";

/**
 * Renders the whole UI into `root`, connected to the agent through `endpoint`. Every host (the web server, later the
 * desktop app) calls this and nothing else, so the UI is written once. Without an endpoint the page says how to get
 * one (`missing`).
 */
export const mount = (root: HTMLElement, endpoint: Endpoint | undefined, missing: string) =>
  createRoot(root).render(
    endpoint ? (
      <App connection={connect(endpoint)} />
    ) : (
      <div className="grid h-dvh place-items-center p-6">
        <div className="max-w-sm border border-line bg-card px-6 py-5">
          <h1 className="flex items-center gap-2 font-serif text-2xl font-semibold">
            <RuneMark className="size-7" />
            Verdandi
          </h1>
          <p className="mt-2 text-muted">{missing}</p>
        </div>
      </div>
    ),
  );
