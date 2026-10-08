/**
 * The page's player: resolves the composition's length, moves every runtime to a time, shows each clip only inside its
 * window, and owns `<video>`/`<audio>` playback. Preview plays it on a real clock; a render seeks it frame by frame
 * through `window.__vd`.
 */
import type { VideoClip, VideoManifest, VideoMedia } from "@verdandi/contracts";
import { type Adapter, animationsAdapter, animeAdapter, lottieAdapter, seekEventAdapter, timelinesAdapter } from "./adapters.ts";
import { Clips, compositionRoot } from "./clips.ts";
import { playbackRate, positive, quantize, sourceTime, visibleAt } from "./timing.ts";
import { crossfade, transitionsAt } from "./transitions.ts";

export type MediaClip = VideoMedia;
export type ClipInfo = VideoClip;
export type Manifest = VideoManifest;

/** A video frame the renderer must paint at a seek: the source time it shows. */
export type FrameTarget = { readonly renderId: string; readonly src: string; readonly sourceTime: number };

const timedSelector = "[data-start]";
const hiddenByAuthor = (el: Element) => !!el.closest("[data-hidden]");

const kindOf = (el: Element): ClipInfo["kind"] =>
  el instanceof HTMLVideoElement
    ? "video"
    : el instanceof HTMLAudioElement
      ? "audio"
      : el instanceof HTMLImageElement
        ? "image"
        : el.hasAttribute("data-composition-id")
          ? "composition"
          : "element";

export class Player {
  readonly clips = new Clips();
  private readonly adapters: Adapter[];
  private time = 0;
  private playing = false;
  private frame = 0;
  private origin = 0;
  readonly render: boolean;

  constructor(readonly fps: number) {
    this.render = !!window.__vdRender;
    this.adapters = [
      timelinesAdapter(this.clips),
      animationsAdapter(this.clips),
      lottieAdapter(this.clips),
      animeAdapter,
      seekEventAdapter,
    ];
  }

  get root() {
    return compositionRoot();
  }

  get currentTime() {
    return this.time;
  }

  get isPlaying() {
    return this.playing;
  }

  /** The render length: the root's `data-duration`, else the furthest end any runtime, clip or media reaches. */
  duration() {
    const root = this.root;
    const declared = positive(root?.getAttribute("data-duration"));
    if (declared !== undefined) return declared;
    let end = 0;
    for (const a of this.adapters) end = Math.max(end, a.duration?.() ?? 0);
    for (const el of document.querySelectorAll(timedSelector)) {
      if (el === root) continue;
      const e = this.clips.end(el);
      if (Number.isFinite(e)) end = Math.max(end, e);
    }
    return end;
  }

  /** Lays out the root at its canvas size and takes timed children out of flow, as the contract promises authors. */
  layout() {
    const root = this.root;
    if (!(root instanceof HTMLElement)) return;
    for (const el of [document.documentElement, document.body]) {
      el.style.margin = "0";
      el.style.overflow = "hidden";
    }
    const w = positive(root.getAttribute("data-width")) ?? 1920;
    const h = positive(root.getAttribute("data-height")) ?? 1080;
    if (!getComputedStyle(root).position.match(/absolute|fixed|relative/)) root.style.position = "relative";
    root.style.overflow = "hidden";
    root.style.width = `${w}px`;
    root.style.height = `${h}px`;
    for (const child of root.children) {
      if (!(child instanceof HTMLElement) || !child.hasAttribute("data-start") || child instanceof HTMLAudioElement) continue;
      if (!/absolute|fixed/.test(getComputedStyle(child).position)) child.style.position = "absolute";
    }
    let n = 0;
    for (const media of document.querySelectorAll("video, audio")) {
      if (!media.hasAttribute("data-vd-render-id")) media.setAttribute("data-vd-render-id", media.id || `vd-media-${++n}`);
    }
  }

  /** Every media element on the timeline, with its window resolved. */
  media(): MediaClip[] {
    const duration = this.duration();
    return [...document.querySelectorAll<HTMLMediaElement>("video[data-start], audio[data-start]")].map((el) => {
      const start = this.clips.start(el);
      const end = Math.min(this.clips.end(el), duration);
      const video = el instanceof HTMLVideoElement;
      return {
        renderId: el.getAttribute("data-vd-render-id") ?? "",
        kind: video ? "video" : "audio",
        src: el.currentSrc || el.src || el.querySelector("source")?.src || "",
        start,
        end,
        mediaStart: Number(el.getAttribute("data-playback-start") ?? el.getAttribute("data-media-start") ?? 0) || 0,
        rate: playbackRate(el.getAttribute("data-playback-rate")),
        loop: el.loop,
        volume: Math.min(3.98, Math.max(0, Number(el.getAttribute("data-volume") ?? 1) || 0)),
        audible: !video || (!el.muted && !el.hasAttribute("muted") && el.getAttribute("data-has-audio") !== "false"),
        hidden: hiddenByAuthor(el),
      } satisfies MediaClip;
    });
  }

  manifest(): Manifest {
    const root = this.root;
    const clips = [...document.querySelectorAll(timedSelector)]
      .filter((el) => el !== root)
      .map((el) => {
        const end = this.clips.end(el);
        return {
          id: el.id || el.getAttribute("data-vd-authored-id") || undefined,
          label: el.getAttribute("data-label") ?? el.id ?? el.tagName.toLowerCase(),
          kind: kindOf(el),
          start: this.clips.start(el),
          end: Number.isFinite(end) ? end : null,
          track:
            Number.parseInt(
              el.getAttribute("data-track-index") ?? el.getAttribute("data-track") ?? el.getAttribute("data-layer") ?? "0",
              10,
            ) || 0,
          hidden: hiddenByAuthor(el),
          compositionId: el.getAttribute("data-composition-id") ?? undefined,
        } satisfies ClipInfo;
      });
    return {
      id: root?.getAttribute("data-composition-id") ?? "",
      width: positive(root?.getAttribute("data-width")) ?? 1920,
      height: positive(root?.getAttribute("data-height")) ?? 1080,
      duration: this.duration(),
      clips,
      media: this.media(),
    };
  }

  /** Shows each timed element only inside its window (and its timed ancestors'); `data-hidden` hides it outright. */
  private applyVisibility(t: number) {
    const root = this.root;
    const duration = this.duration();
    for (const el of document.querySelectorAll<HTMLElement>(timedSelector)) {
      if (el === root) continue;
      if (el.hasAttribute("data-hidden")) {
        el.style.display = "none";
        el.dataset.vdHidden = "";
        continue;
      }
      if (el.dataset.vdHidden !== undefined) {
        el.style.display = "";
        delete el.dataset.vdHidden;
      }
      let visible = true;
      for (let node: Element | null = el; node && node !== root; node = node.parentElement?.closest(timedSelector) ?? null)
        if (!visibleAt(t, this.clips.start(node), this.clips.end(node), duration)) {
          visible = false;
          break;
        }
      el.style.visibility = visible ? "visible" : "hidden";
    }
    for (const el of document.querySelectorAll<HTMLElement>("[data-hidden]:not([data-start])")) el.style.display = "none";
  }

  /** Preview: media plays along with the clock and is re-synced when it drifts. Render: media never plays (frames are painted). */
  private syncMedia(t: number) {
    for (const clip of this.media()) {
      const el = document.querySelector<HTMLMediaElement>(`[data-vd-render-id="${CSS.escape(clip.renderId)}"]`);
      if (!el) continue;
      const active = !clip.hidden && t >= clip.start && t < clip.end;
      if (this.render || !active) {
        if (!el.paused) el.pause();
        if (!this.render && active === false && t < clip.start) el.currentTime = clip.mediaStart;
        continue;
      }
      const want = sourceTime(
        t - clip.start,
        clip.mediaStart,
        clip.rate,
        Number.isFinite(el.duration) ? el.duration : undefined,
        clip.loop,
      );
      el.playbackRate = clip.rate;
      el.volume = Math.min(1, clip.volume);
      if (Math.abs(el.currentTime - want) > (this.playing ? 0.3 : 0.01)) el.currentTime = want;
      if (this.playing && el.paused)
        void el.play().catch(() => window.parent?.postMessage({ source: "vd-player", type: "autoplay-blocked" }, "*"));
      if (!this.playing && !el.paused) el.pause();
    }
  }

  /** The video frames to paint for time `t` in a render: each active, visible video and the source time it shows. */
  frameTargets(t: number): FrameTarget[] {
    return this.media()
      .filter((m) => m.kind === "video" && !m.hidden && t >= m.start && t < m.end)
      .map((m) => {
        const el = document.querySelector<HTMLVideoElement>(`video[data-vd-render-id="${CSS.escape(m.renderId)}"]`);
        const length = el && Number.isFinite(el.duration) ? el.duration : undefined;
        return { renderId: m.renderId, src: m.src, sourceTime: sourceTime(t - m.start, m.mediaStart, m.rate, length, m.loop) };
      });
  }

  /**
   * Paints video frames over their `<video>` elements (render only): an `<img>` sibling that mirrors the video's box,
   * transform, opacity and fit, so animations on the video carry over. Resolves once every image decoded.
   */
  async paintFrames(frames: readonly { readonly renderId: string; readonly url: string }[]) {
    const wanted = new Set(frames.map((f) => f.renderId));
    for (const img of document.querySelectorAll<HTMLImageElement>("img[data-vd-frame]"))
      if (!wanted.has(img.dataset.vdFrame ?? "")) img.style.visibility = "hidden";
    await Promise.all(
      frames.map(async ({ renderId, url }) => {
        const video = document.querySelector<HTMLVideoElement>(`video[data-vd-render-id="${CSS.escape(renderId)}"]`);
        if (!video) return;
        let img =
          video.nextElementSibling instanceof HTMLImageElement && video.nextElementSibling.dataset.vdFrame === renderId
            ? video.nextElementSibling
            : null;
        if (!img) {
          img = document.createElement("img");
          img.dataset.vdFrame = renderId;
          img.decoding = "sync";
          video.after(img);
        }
        const s = getComputedStyle(video);
        Object.assign(img.style, {
          position: "absolute",
          left: `${video.offsetLeft}px`,
          top: `${video.offsetTop}px`,
          width: `${video.offsetWidth}px`,
          height: `${video.offsetHeight}px`,
          margin: "0",
          transform: s.transform,
          transformOrigin: s.transformOrigin,
          opacity: s.opacity,
          filter: s.filter,
          borderRadius: s.borderRadius,
          clipPath: s.clipPath,
          objectFit: s.objectFit,
          objectPosition: s.objectPosition,
          zIndex: s.zIndex,
          mixBlendMode: s.mixBlendMode,
          visibility: s.visibility,
        });
        video.style.setProperty("visibility", "hidden", "important");
        if (img.src !== url) {
          img.src = url;
          await img.decode().catch(() => console.error(`[verdandi] could not decode frame ${url}`));
        }
      }),
    );
  }

  /** Moves everything to `t` and resolves once every runtime has drawn it (render seeks land on the frame grid). */
  async seek(t: number, opts: { readonly exact?: boolean } = {}) {
    const time = this.render && !opts.exact ? quantize(t, this.fps) : Math.max(0, t);
    this.time = time;
    const pending: Promise<unknown>[] = [];
    for (const a of this.adapters) {
      try {
        a.seek(time, pending);
      } catch (error) {
        console.error(`[verdandi] ${a.name} seek failed:`, error);
      }
    }
    this.applyVisibility(time);
    // A render blends shader transitions from captured pictures; the preview can only crossfade.
    if (!this.render) crossfade(transitionsAt(this.clips, time));
    this.syncMedia(time);
    window.__VD_VIRTUAL_TIME__?.seekToTime(time * 1000);
    await Promise.all(pending);
    this.post();
  }

  play() {
    if (this.playing) return;
    const end = this.duration();
    if (this.time >= end) this.time = 0;
    this.playing = true;
    this.origin = performance.now() - this.time * 1000;
    const tick = () => {
      if (!this.playing) return;
      const t = (performance.now() - this.origin) / 1000;
      if (t >= end) {
        void this.seek(end);
        this.pause();
        window.parent?.postMessage({ source: "vd-player", type: "ended" }, "*");
        return;
      }
      void this.seek(t);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.frame);
    this.syncMedia(this.time);
    this.post();
  }

  /** Tells an embedding player (the `<verdandi-player>` element) where playback is. */
  private post() {
    if (window.parent !== window)
      window.parent.postMessage({ source: "vd-player", type: "state", time: this.time, playing: this.playing }, "*");
  }
}

declare global {
  interface Window {
    __vdRender?: { readonly fps: number };
    /** The render clock (`virtual-time.ts`), present only in a render. */
    __VD_VIRTUAL_TIME__?: { seekToTime: (ms: number) => void; realNow: () => number; realRaf: (cb: FrameRequestCallback) => number };
  }
}
