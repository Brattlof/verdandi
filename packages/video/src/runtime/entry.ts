/**
 * The runtime's entry, bundled to one script that runs in the composition's `<head>`, before the author's scripts.
 * It boots once the document parsed: mounts sub-compositions, waits for fonts, images, media metadata and any
 * `window.__vdBuildReady` promises, then seeks to 0 and publishes `window.__vd`, the protocol renderers and players use.
 */
import { applyVariables, compositionApi, declaredDefaults, mountCompositions, variablesByComposition } from "./assemble.ts";
import { compositionRoot } from "./clips.ts";
import { type FrameTarget, type Manifest, Player } from "./player.ts";
import { type ActiveTransition, clearComposite, composite, isolate, restore, transitionsAt } from "./transitions.ts";

window.__timelines ??= {};

/** What a renderer or embedding player drives. `ready` turns true once the composition can be seeked. */
export type VdProtocol = {
  ready: boolean;
  error: string | undefined;
  duration: () => number;
  seek: (t: number, opts?: { exact?: boolean }) => Promise<void>;
  manifest: () => Manifest;
  frameTargets: (t: number) => FrameTarget[];
  paintFrames: (frames: readonly { renderId: string; url: string }[]) => Promise<void>;
  play: () => void;
  pause: () => void;
  currentTime: () => number;
  /** Shader transitions running at `t` (render). */
  transitionsAt: (t: number) => ActiveTransition[];
  /** Hides the scenes `ids` until `restore`, to capture the other side of a transition alone. */
  isolate: (ids: readonly string[]) => void;
  restore: () => void;
  /** Covers the composition with `shader` blending two captured pictures (data URLs) at `progress`. */
  composite: (opts: { shader: string; from: string; to: string; progress: number }) => Promise<void>;
  clearComposite: () => void;
};

const fps = window.__vdRender?.fps ?? 30;
const player = new Player(fps);
const vd: VdProtocol = {
  ready: false,
  error: undefined,
  duration: () => player.duration(),
  seek: (t, opts) => player.seek(t, opts),
  manifest: () => player.manifest(),
  frameTargets: (t) => player.frameTargets(t),
  paintFrames: (frames) => player.paintFrames(frames),
  play: () => player.play(),
  pause: () => player.pause(),
  currentTime: () => player.currentTime,
  transitionsAt: (t) => transitionsAt(player.clips, t),
  isolate,
  restore,
  composite: async (opts) => {
    const root = player.root;
    if (root instanceof HTMLElement) await composite(root, opts);
  },
  clearComposite,
};
window.__vd = vd;
window.__vdBuildReady ??= [];

const timeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))]);

const mediaMetadata = () =>
  Promise.all(
    [...document.querySelectorAll<HTMLMediaElement>("video, audio")].map((el) =>
      el.readyState >= 1 || el.error
        ? undefined
        : new Promise<void>((resolve) => {
            el.addEventListener("loadedmetadata", () => resolve(), { once: true });
            el.addEventListener("error", () => resolve(), { once: true });
            if (el.preload === "none") el.preload = "metadata";
          }),
    ),
  );

const images = () => Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));

const boot = async () => {
  const root = compositionRoot();
  const rootId = root?.getAttribute("data-composition-id") ?? "";
  variablesByComposition.set(rootId, {
    ...declaredDefaults(document.documentElement),
    ...declaredDefaults(root),
    ...(window.__vdVariables ?? {}),
  });
  window.__verdandi = compositionApi(rootId, document.baseURI);
  if (root) applyVariables(root, variablesByComposition.get(rootId) ?? {}, document.baseURI);
  await mountCompositions();
  // Real timers: the render clock is frozen, and a missing font or a stalled video must not hang the page.
  await timeout(Promise.all([document.fonts.ready, images(), mediaMetadata(), Promise.allSettled(window.__vdBuildReady ?? [])]), 15_000);
  player.layout();
  player.clips.reset();
  await player.seek(0);
  vd.ready = true;
  window.dispatchEvent(new Event("vd-ready"));
  if (window.parent !== window) window.parent.postMessage({ source: "vd-player", type: "ready", manifest: player.manifest() }, "*");
};

/** Commands from an embedding `<verdandi-player>` (same origin or not). */
window.addEventListener("message", (event: MessageEvent<{ source?: string; action?: string; time?: number }>) => {
  const data = event.data;
  if (data?.source !== "vd-host" || !vd.ready) return;
  if (data.action === "play") player.play();
  else if (data.action === "pause") player.pause();
  else if (data.action === "seek" && typeof data.time === "number") {
    player.pause();
    void player.seek(data.time);
  }
});

const start = () =>
  boot().catch((error: unknown) => {
    vd.error = error instanceof Error ? error.message : String(error);
    console.error("[verdandi] runtime failed to start:", error);
  });

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
else void start();

declare global {
  interface Window {
    __vd?: VdProtocol;
    __vdBuildReady?: Promise<unknown>[];
    __verdandi?: ReturnType<typeof compositionApi>;
  }
}
