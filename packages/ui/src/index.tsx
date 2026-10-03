import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { connect, type Endpoint } from "./client.ts";
import { Pairing } from "./devices/devices.tsx";
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

/**
 * Asks to pair this device with the agent behind `base` (ADR 0028), showing the code to read to the owner, and resolves
 * with the device token once approved. The host keeps the token, then mounts the UI with it as a device endpoint.
 */
export const pair = (root: HTMLElement, base: string) =>
  new Promise<string>((resolve) => {
    const screen = createRoot(root);
    screen.render(
      <Pairing
        base={base}
        onPaired={(token) => {
          screen.unmount();
          resolve(token);
        }}
      />,
    );
  });
