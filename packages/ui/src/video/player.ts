/**
 * `<verdandi-player src="…">`: plays a composition in a sandboxed iframe (`allow-scripts` only, so an opaque origin:
 * its scripts can't reach this page, its storage or its token), scaled to fit the element. It talks to the runtime
 * only by postMessage. Events: `ready` (detail: the manifest), `timeupdate` (detail: { time, playing }), `ended`.
 */
import type { VideoManifest as Manifest } from "@verdandi/contracts";

type FromRuntime =
  | { readonly source: "vd-player"; readonly type: "ready"; readonly manifest: Manifest }
  | { readonly source: "vd-player"; readonly type: "state"; readonly time: number; readonly playing: boolean }
  | { readonly source: "vd-player"; readonly type: "ended" | "autoplay-blocked" };

export class VerdandiPlayer extends HTMLElement {
  static readonly observedAttributes = ["src"];
  private readonly frame = document.createElement("iframe");
  private readonly resize = new ResizeObserver(() => this.fit());
  manifest: Manifest | undefined;
  currentTime = 0;
  playing = false;

  constructor() {
    super();
    const root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent =
      ":host{display:block;position:relative;overflow:hidden;background:#000}iframe{position:absolute;left:0;top:0;border:0;transform-origin:0 0;background:#000}";
    this.frame.setAttribute("sandbox", "allow-scripts");
    this.frame.setAttribute("allow", "autoplay");
    this.frame.setAttribute("referrerpolicy", "no-referrer");
    this.frame.title = "Composition preview";
    root.append(style, this.frame);
  }

  connectedCallback() {
    addEventListener("message", this.onMessage);
    this.resize.observe(this);
    this.load();
  }

  disconnectedCallback() {
    removeEventListener("message", this.onMessage);
    this.resize.disconnect();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.load();
  }

  /** Loads (or reloads, after an edit) the composition, then returns to `resumeAt` once it is ready. */
  load(resumeAt?: number) {
    const src = this.getAttribute("src");
    if (!src) return;
    this.manifest = undefined;
    this.resumeAt = resumeAt;
    this.frame.src = src;
  }

  private resumeAt: number | undefined;

  play() {
    this.post({ action: "play" });
  }

  pause() {
    this.post({ action: "pause" });
  }

  seek(time: number) {
    this.currentTime = time;
    this.post({ action: "seek", time });
  }

  private post(message: { action: "play" | "pause" | "seek"; time?: number }) {
    // The frame's origin is opaque, so "*" is the only target that reaches it; the message carries nothing secret.
    this.frame.contentWindow?.postMessage({ source: "vd-host", ...message }, "*");
  }

  private fit() {
    const m = this.manifest;
    const w = m?.width ?? 1920;
    const h = m?.height ?? 1080;
    const box = this.getBoundingClientRect();
    const scale = Math.min(box.width / w, box.height / h) || 1;
    Object.assign(this.frame.style, {
      width: `${w}px`,
      height: `${h}px`,
      transform: `translate(${(box.width - w * scale) / 2}px, ${(box.height - h * scale) / 2}px) scale(${scale})`,
    });
  }

  private readonly onMessage = (event: MessageEvent<FromRuntime>) => {
    if (event.source !== this.frame.contentWindow || event.data?.source !== "vd-player") return;
    const data = event.data;
    if (data.type === "ready") {
      this.manifest = data.manifest;
      this.fit();
      if (this.resumeAt) this.seek(Math.min(this.resumeAt, data.manifest.duration));
      this.dispatchEvent(new CustomEvent("ready", { detail: data.manifest }));
    } else if (data.type === "state") {
      this.currentTime = data.time;
      this.playing = data.playing;
      this.dispatchEvent(new CustomEvent("timeupdate", { detail: { time: data.time, playing: data.playing } }));
    } else if (data.type === "ended") {
      this.playing = false;
      this.dispatchEvent(new Event("ended"));
    }
  };
}

if (!customElements.get("verdandi-player")) customElements.define("verdandi-player", VerdandiPlayer);
