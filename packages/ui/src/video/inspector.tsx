import type { VideoClip, VideoManifest } from "@verdandi/contracts";
import { useEffect, useState } from "react";
import { seconds } from "./patch.ts";

type Field = { readonly name: string; readonly label: string; readonly value: string; readonly step: number; readonly min?: number };

/**
 * Exact values for the selected clip: start, duration and track, hidden, and for media its volume. A field is written
 * when it loses focus or on Enter, one attribute at a time, like a timeline drag.
 */
export const Inspector = ({
  clip,
  manifest,
  onChange,
}: {
  clip: VideoClip;
  manifest: VideoManifest;
  onChange: (name: string, value: string | null, label: string) => void;
}) => {
  const media = manifest.media.find((m) => m.renderId === clip.id);
  const fields: Field[] = [
    { name: "data-start", label: "Start (s)", value: seconds(clip.start), step: 1 / 30, min: 0 },
    ...(clip.end === null
      ? []
      : [{ name: "data-duration", label: "Duration (s)", value: seconds(clip.end - clip.start), step: 1 / 30, min: 1 / 30 }]),
    { name: "data-track-index", label: "Track", value: String(clip.track), step: 1, min: 0 },
    ...(media ? [{ name: "data-volume", label: "Volume", value: String(media.volume), step: 0.05, min: 0 }] : []),
  ];
  return (
    <section aria-label={`Clip ${clip.id}`} className="rounded-md border border-line bg-card p-3">
      <h2 className="eyebrow mb-2 text-muted">
        {clip.kind} · {clip.id}
      </h2>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
        {fields.map((f) => (
          <NumberField
            key={`${clip.id}-${f.name}-${f.value}`}
            field={f}
            onCommit={(v) => onChange(f.name, v, `Set ${f.label.replace(/ \(s\)$/, "").toLowerCase()} of ${clip.id}`)}
          />
        ))}
      </div>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={clip.hidden}
          onChange={(e) => onChange("data-hidden", e.target.checked ? "" : null, `${e.target.checked ? "Hide" : "Show"} ${clip.id}`)}
        />
        Hidden (in the preview and the render)
      </label>
    </section>
  );
};

const NumberField = ({ field, onCommit }: { field: Field; onCommit: (value: string) => void }) => {
  const [draft, setDraft] = useState(field.value);
  useEffect(() => setDraft(field.value), [field.value]);
  const id = `inspector-${field.name}`;
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n) || (field.min !== undefined && n < field.min)) return setDraft(field.value);
    const value = field.step === 1 ? String(Math.round(n)) : seconds(n);
    if (value !== field.value) onCommit(value);
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted">
        {field.label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        step={field.step}
        min={field.min}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        className="w-full"
      />
    </div>
  );
};
