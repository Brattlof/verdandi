import type { VideoClip, VideoManifest } from "@verdandi/contracts";
import { useRef, useState } from "react";

const fps = 30;
const frame = 1 / fps;
const snap = (t: number) => Math.round(t / frame) * frame;
const label = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;

type Drag = { readonly clip: VideoClip; readonly edge: "move" | "end"; readonly x: number; readonly delta: number };

/**
 * The composition's tracks and clips, a ruler and the playhead. Click the ruler to seek; drag a clip to move it, or its
 * right edge to trim it (snapped to frames). A focused clip moves by a frame with ←/→ (Shift: ten), and H hides or
 * shows it; Alt+←/→ trims its end. Only clips with an id can be edited: that is how the source is found.
 */
export const Timeline = ({
  manifest,
  time,
  onSeek,
  onMove,
  onTrim,
  onToggleHidden,
}: {
  manifest: VideoManifest;
  time: number;
  onSeek: (t: number) => void;
  onMove: (clip: VideoClip, start: number) => void;
  onTrim: (clip: VideoClip, duration: number) => void;
  onToggleHidden: (clip: VideoClip) => void;
}) => {
  const lane = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag>();
  const duration = Math.max(manifest.duration, 0.001);
  const pct = (t: number) => `${(Math.min(Math.max(t, 0), duration) / duration) * 100}%`;
  const secondsPerPixel = () => duration / (lane.current?.getBoundingClientRect().width || 1);
  const tracks = [...new Set(manifest.clips.map((c) => c.track))].sort((a, b) => a - b);

  const begin = (e: React.PointerEvent, clip: VideoClip, edge: Drag["edge"]) => {
    if (!clip.id || e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ clip, edge, x: e.clientX, delta: 0 });
  };
  const moveDrag = (e: React.PointerEvent) => drag && setDrag({ ...drag, delta: snap((e.clientX - drag.x) * secondsPerPixel()) });
  const end = () => {
    if (!drag) return;
    const { clip, edge, delta } = drag;
    setDrag(undefined);
    if (Math.abs(delta) < frame / 2) return;
    if (edge === "move") onMove(clip, Math.max(0, snap(clip.start + delta)));
    else if (clip.end !== null) onTrim(clip, Math.max(frame, snap(clip.end - clip.start + delta)));
  };

  const ticks = Array.from({ length: Math.floor(duration) + 1 }, (_, i) => i).filter(
    (i) => duration <= 20 || i % Math.ceil(duration / 20) === 0,
  );

  return (
    <div className="flex min-h-0 flex-col gap-1 text-xs select-none">
      <div className="flex items-center gap-2 text-muted">
        <span className="font-mono tabular-nums">
          {label(time)} / {label(manifest.duration)}
        </span>
        <span>
          {manifest.width}×{manifest.height}
        </span>
      </div>
      <div className="flex">
        <div className="w-14 shrink-0" />
        <div
          ref={lane}
          className="relative h-6 flex-1 cursor-pointer border-b border-line"
          onPointerDown={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            onSeek(((e.clientX - box.left) / box.width) * duration);
          }}
        >
          {ticks.map((i) => (
            <span key={i} className="absolute top-0 h-full border-l border-line pl-1 text-[10px] text-muted" style={{ left: pct(i) }}>
              {i}s
            </span>
          ))}
          <span aria-hidden className="absolute top-0 h-full w-px bg-accent" style={{ left: pct(time) }} />
        </div>
      </div>
      <ul className="flex flex-col gap-1 overflow-y-auto" aria-label="Tracks">
        {tracks.map((track) => (
          <li key={track} className="flex items-stretch">
            <span className="w-14 shrink-0 self-center text-muted">Track {track}</span>
            <ul className="relative h-8 flex-1 rounded-sm bg-panel" aria-label={`Track ${track}`}>
              {manifest.clips
                .filter((c) => c.track === track)
                .map((clip) => {
                  const d = drag?.clip === clip ? drag : undefined;
                  const start = clip.start + (d?.edge === "move" ? d.delta : 0);
                  const stop = (clip.end ?? manifest.duration) + (d ? d.delta : 0);
                  const name = clip.id ?? clip.label;
                  return (
                    <li
                      key={`${clip.id ?? clip.label}-${clip.start}`}
                      className="absolute inset-y-0.5"
                      style={{ left: pct(start), width: `calc(${pct(stop)} - ${pct(start)})` }}
                    >
                      <button
                        type="button"
                        aria-label={`${name}, ${clip.kind}, ${label(clip.start)} to ${clip.end === null ? "the end" : label(clip.end)}${clip.hidden ? ", hidden" : ""}`}
                        title={clip.id ? "Drag to move, drag the right edge to trim, H to hide" : "Give this element an id to edit it here"}
                        className={`flex h-full w-full items-center overflow-hidden rounded-sm border px-1.5 text-left text-[11px] ${clip.hidden ? "border-dashed border-line-strong bg-transparent text-muted" : "border-line-strong bg-user"} ${clip.id ? "cursor-grab" : "cursor-default"}`}
                        onPointerDown={(e) => begin(e, clip, "move")}
                        onPointerMove={moveDrag}
                        onPointerUp={end}
                        onClick={() => onSeek(clip.start)}
                        onKeyDown={(e) => {
                          if (!clip.id) return;
                          const step = (e.shiftKey ? 10 : 1) * frame;
                          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                            e.preventDefault();
                            const by = e.key === "ArrowLeft" ? -step : step;
                            // Alt trims the end instead of moving the clip.
                            if (e.altKey && clip.end !== null) onTrim(clip, Math.max(frame, snap(clip.end - clip.start + by)));
                            else if (!e.altKey) onMove(clip, Math.max(0, snap(clip.start + by)));
                          } else if (e.key === "h" || e.key === "H") onToggleHidden(clip);
                        }}
                      >
                        <span className="truncate">{name}</span>
                      </button>
                      {clip.id && clip.end !== null && (
                        <span
                          aria-hidden
                          className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r-sm bg-line-strong/60"
                          onPointerDown={(e) => begin(e, clip, "end")}
                          onPointerMove={moveDrag}
                          onPointerUp={end}
                        />
                      )}
                    </li>
                  );
                })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
};
