/**
 * How each animation runtime is moved to a time. Every adapter is seek-only: nothing in a composition runs on its own
 * clock, so the same time always draws the same frame.
 */
import type { Clips } from "./clips.ts";

type Timeline = {
  totalTime: (t: number, suppressEvents?: boolean) => unknown;
  totalDuration: () => number;
  duration: () => number;
  pause: () => unknown;
  parent?: { parent?: unknown } | null;
};

const isTimeline = (v: unknown): v is Timeline =>
  !!v &&
  typeof (v as Timeline).totalTime === "function" &&
  typeof (v as Timeline).duration === "function" &&
  typeof (v as Timeline).pause === "function";

export type SeekEvent = { readonly time: number; readonly waitUntil: (p: Promise<unknown>) => void };

export type Adapter = {
  readonly name: string;
  /** Moves this runtime to `time` seconds on the root timeline; promises it pushes must settle before the frame is captured. */
  seek(time: number, pending: Promise<unknown>[]): void;
  /** How long its animations run on the root timeline, when it can tell (CSS and WAAPI can). */
  duration?(): number | undefined;
};

/**
 * Registered GSAP (or GSAP-shaped) timelines: each one a composition registered at the top level is seeked at its
 * host's local time, held at its last frame past its end. One an author nested in another is left to its parent.
 */
export const timelinesAdapter = (clips: Clips): Adapter => ({
  name: "timelines",
  seek(time) {
    for (const [id, tl] of Object.entries(window.__timelines)) {
      if (!isTimeline(tl) || tl.parent?.parent) continue;
      const host = document.querySelector(`[data-composition-id="${CSS.escape(id)}"]`);
      const local = Math.max(0, time - (host ? clips.start(host) : 0));
      const total = tl.totalDuration();
      tl.pause();
      tl.totalTime(Number.isFinite(total) ? Math.min(local, total) : local, false);
    }
  },
  duration() {
    const root = document.querySelector("[data-composition-id]")?.getAttribute("data-composition-id");
    const tl = root ? window.__timelines[root] : undefined;
    const d = isTimeline(tl) ? tl.duration() : Number.NaN;
    return Number.isFinite(d) && d > 0 && d < 7200 ? d : undefined;
  },
});

/** CSS animations and Web Animations: each is held at the time since its nearest timed ancestor started. */
export const animationsAdapter = (clips: Clips): Adapter => {
  const timed = (a: Animation) => {
    const target = (a.effect as KeyframeEffect | null)?.target;
    const host = target instanceof Element ? target.closest("[data-start]") : null;
    return host ? clips.start(host) : 0;
  };
  return {
    name: "animations",
    seek(time) {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = Math.max(0, time - timed(a)) * 1000;
      }
    },
    duration() {
      let end = 0;
      for (const a of document.getAnimations()) {
        const t = a.effect?.getComputedTiming().endTime;
        if (typeof t === "number" && Number.isFinite(t)) end = Math.max(end, timed(a) + t / 1000);
      }
      return end > 0 ? end : undefined;
    },
  };
};

type LottieAnim = {
  goToAndStop: (frame: number, isFrame: boolean) => void;
  totalFrames: number;
  frameRate: number;
  loop?: boolean | number;
  wrapper?: Element;
};

/** lottie-web animations (`lottie.getRegisteredAnimations()` and `window.__vdLottie`), stopped at the matching frame. */
export const lottieAdapter = (clips: Clips): Adapter => {
  const all = (): LottieAnim[] => [
    ...((window.lottie?.getRegisteredAnimations?.() as LottieAnim[] | undefined) ?? []),
    ...(window.__vdLottie ?? []),
  ];
  return {
    name: "lottie",
    seek(time) {
      for (const anim of new Set(all())) {
        const host = anim.wrapper?.closest("[data-composition-id]");
        const frames = Math.max(0, (time - (host ? clips.start(host) : 0)) * anim.frameRate);
        const last = Math.max(0, anim.totalFrames - 1);
        anim.goToAndStop(anim.loop ? frames % anim.totalFrames : Math.min(frames, last), true);
      }
    },
    duration() {
      const ends = all().map((a) => a.totalFrames / a.frameRate);
      return ends.length ? Math.max(...ends) : undefined;
    },
  };
};

/** anime.js instances an author registered on `window.__vdAnime`. */
export const animeAdapter: Adapter = {
  name: "anime",
  seek(time) {
    for (const a of window.__vdAnime ?? []) a.seek(time * 1000);
  },
};

/**
 * Anything else (Three.js, canvas, WebGPU) listens for `vd-seek` on `window`: `detail.time` is the time to draw, and
 * `detail.waitUntil(promise)`, called synchronously, holds the frame until the promise settles.
 */
export const seekEventAdapter: Adapter = {
  name: "vd-seek",
  seek(time, pending) {
    window.dispatchEvent(new CustomEvent<SeekEvent>("vd-seek", { detail: { time, waitUntil: (p) => pending.push(p) } }));
  },
};

declare global {
  interface Window {
    lottie?: { getRegisteredAnimations?: () => unknown[] };
    __vdLottie?: LottieAnim[];
    __vdAnime?: { seek: (ms: number) => void }[];
  }
}
