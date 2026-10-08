/**
 * Clip timing over the live DOM: where each timed element starts and ends on the root timeline. `data-start` is local
 * to the nearest enclosing composition, or names another clip whose end it follows.
 */
import { parseStart, positive } from "./timing.ts";

/** The composition root: `[data-root="true"]`, else the first composition in the document. */
export const compositionRoot = () =>
  document.querySelector('[data-composition-id][data-root="true"]') ?? document.querySelector("[data-composition-id]");

const isComposition = (el: Element) => el.hasAttribute("data-composition-id");

/** The composition `el` sits in: its nearest composition ancestor (not `el` itself). */
const enclosing = (el: Element) => el.parentElement?.closest("[data-composition-id]") ?? null;

/** Live duration of a registered timeline, for hosts that don't author `data-duration`. */
const timelineDuration = (id: string | null) => {
  const tl = id ? (window.__timelines[id] as { duration?: () => number } | undefined) : undefined;
  const d = typeof tl?.duration === "function" ? tl.duration() : Number.NaN;
  return Number.isFinite(d) && d > 0 && d < 7200 ? d : undefined;
};

/** Natural length of a media element (source length after its offset, at its rate), once metadata loaded. */
const mediaLength = (el: Element) => {
  if (!(el instanceof HTMLMediaElement) || !Number.isFinite(el.duration)) return undefined;
  const offset = Number(el.getAttribute("data-playback-start") ?? el.getAttribute("data-media-start") ?? 0) || 0;
  const rate = Number.parseFloat(el.getAttribute("data-playback-rate") ?? "") || 1;
  return Math.max(0, el.duration - offset) / rate;
};

export class Clips {
  private readonly starts = new Map<Element, number>();
  private readonly resolving = new Set<Element>();

  /** Forget cached starts (after the DOM or registered timelines changed). */
  reset() {
    this.starts.clear();
  }

  /** Seconds on the root timeline where `el` starts. A reference to a missing clip, or a cycle, starts at 0. */
  start(el: Element): number {
    const cached = this.starts.get(el);
    if (cached !== undefined) return cached;
    if (this.resolving.has(el)) return 0;
    this.resolving.add(el);
    const parent = enclosing(el);
    const offset = parent ? this.start(parent) : 0;
    const expr = parseStart(el.getAttribute("data-start"));
    let value = offset;
    if (expr?.kind === "absolute") value = offset + expr.seconds;
    else if (expr?.kind === "ref") {
      const target = document.getElementById(expr.id) ?? document.querySelector(`[data-composition-id="${CSS.escape(expr.id)}"]`);
      if (target) {
        const end = this.end(target);
        value = Math.max(0, (Number.isFinite(end) ? end : this.start(target)) + expr.offset);
      }
    }
    this.resolving.delete(el);
    this.starts.set(el, value);
    return value;
  }

  /** Authored or natural duration of `el`, or `undefined` for a clip that runs to the end. */
  duration(el: Element): number | undefined {
    const authored = positive(el.getAttribute("data-duration"));
    if (authored !== undefined) return authored;
    const start = positive(el.getAttribute("data-start")) ?? 0;
    const end = positive(el.getAttribute("data-end"));
    if (end !== undefined && end > start) return end - start;
    if (el instanceof HTMLMediaElement) return mediaLength(el);
    if (el instanceof HTMLImageElement && el.hasAttribute("data-start")) return 3;
    if (isComposition(el)) return timelineDuration(el.getAttribute("data-composition-id"));
    return undefined;
  }

  /** Seconds on the root timeline where `el` ends; `Infinity` for a clip with no end. */
  end(el: Element) {
    const d = this.duration(el);
    return d === undefined ? Number.POSITIVE_INFINITY : this.start(el) + d;
  }
}
