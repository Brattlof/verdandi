import type { VideoManifest, VideoSlide } from "@verdandi/contracts";
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { VerdandiPlayer } from "./player.ts";
import "./player.ts";

/** `slides[i]` written into the presenter window: its notes, what comes next, and how long the talk has run. */
const presenterHtml = (slides: readonly VideoSlide[], i: number, startedAt: number) => {
  const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const slide = slides[i];
  const next = slides[i + 1];
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  return `<p class="meta">Slide ${i + 1} of ${slides.length} · ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}</p>
<h1>${esc(slide?.title || `Slide ${i + 1}`)}</h1>
<div class="notes">${esc(slide?.notes || "No notes for this slide.")}</div>
<p class="meta">Next: ${next ? esc(next.title || `Slide ${i + 2}`) : "the end"}</p>
<p><button id="prev">← Previous</button> <button id="next">Next →</button></p>`;
};

/**
 * Presenting a slideshow: the composition full screen, played up to each slide's rest point and held there. → or Space
 * goes on (playing the way into the next slide), ← steps back, Home and End jump, P opens a presenter window with the
 * notes, F goes full screen, Escape leaves.
 */
export const Present = ({ src, onExit }: { src: string; onExit: () => void }) => {
  const player = useRef<VerdandiPlayer>(null);
  const [manifest, setManifest] = useState<VideoManifest>();
  const [index, setIndex] = useState(0);
  const presenter = useRef<Window | null>(null);
  const startedAt = useRef(Date.now());
  const slides = manifest?.slides ?? [];

  const go = useCallback(
    (to: number, animate: boolean) => {
      const slide = slides[to];
      if (!slide || !player.current) return;
      setIndex(to);
      if (animate) player.current.playTo(slide.rest);
      else player.current.seek(slide.rest);
    },
    [slides],
  );

  useEffect(() => {
    const el = player.current;
    if (!el) return;
    const ready = (e: Event) => {
      const m = (e as CustomEvent<VideoManifest>).detail;
      setManifest(m);
      // The first slide plays its entrance from the start.
      if (m.slides[0]) el.playTo(m.slides[0].rest);
    };
    el.addEventListener("ready", ready);
    return () => el.removeEventListener("ready", ready);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") {
        e.preventDefault();
        go(Math.min(index + 1, slides.length - 1), true);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        go(Math.max(index - 1, 0), false);
      } else if (e.key === "Home") go(0, false);
      else if (e.key === "End") go(slides.length - 1, false);
      else if (e.key === "Escape") onExit();
      else if (e.key === "f" || e.key === "F") void document.documentElement.requestFullscreen?.().catch(() => undefined);
      else if (e.key === "p" || e.key === "P") {
        presenter.current = window.open("", "vd-presenter", "width=560,height=460");
        if (presenter.current) {
          presenter.current.document.title = "Presenter view";
          presenter.current.document.head.innerHTML =
            "<style>body{font:16px system-ui;margin:24px;background:#151413;color:#eceae5}h1{font-size:28px;margin:8px 0}.notes{font-size:20px;line-height:1.5;white-space:pre-wrap;margin:16px 0}.meta{color:#a6a39c}button{font:inherit;padding:6px 12px}</style>";
        }
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [go, index, slides.length, onExit]);

  // The presenter window follows the slide, and its timer ticks once a second (text only, nothing animates).
  useEffect(() => {
    const draw = () => {
      const w = presenter.current;
      if (!w || w.closed) return;
      w.document.body.innerHTML = presenterHtml(slides, index, startedAt.current);
      w.document.getElementById("prev")?.addEventListener("click", () => go(Math.max(index - 1, 0), false));
      w.document.getElementById("next")?.addEventListener("click", () => go(Math.min(index + 1, slides.length - 1), true));
    };
    draw();
    const timer = setInterval(draw, 1000);
    return () => clearInterval(timer);
  }, [index, slides, go]);

  useEffect(() => () => presenter.current?.close(), []);

  const [w, h] = manifest ? [manifest.width, manifest.height] : [16, 9];
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Presenting"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#000]"
    >
      {createElement("verdandi-player", {
        ref: player,
        src,
        style: { aspectRatio: `${w} / ${h}`, width: `min(100vw, calc(100vh * ${w} / ${h}))` },
      })}
      <p className="absolute bottom-2 left-3 text-xs text-[#a6a39c]" aria-live="polite">
        {manifest
          ? slides.length
            ? `Slide ${index + 1} of ${slides.length} · → next, ← back, P notes, F full screen, Esc leave`
            : "This composition has no slides: mark each scene with data-slide. Esc leaves."
          : "Loading…"}
      </p>
      <button type="button" onClick={onExit} className="absolute top-2 right-2 border-0 bg-transparent text-[#d6d3cc]">
        Leave
      </button>
    </div>
  );
};
