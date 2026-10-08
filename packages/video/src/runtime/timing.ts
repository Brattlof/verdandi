/**
 * The composition contract's timing grammar and windows, shared by the in-page runtime, lint and the timeline view.
 * Pure: no DOM, so it runs in Bun tests and in the browser bundle alike.
 */

/** A parsed `data-start`: seconds, or `<id>`, `<id> + n`, `<id> - n` (the end of another clip, shifted). */
export type StartExpr =
  | { readonly kind: "absolute"; readonly seconds: number }
  | { readonly kind: "ref"; readonly id: string; readonly offset: number };

const refId = /^[A-Za-z0-9_.:-]+$/;
const refShift = /^([A-Za-z0-9_.:-]+)\s*([+-])\s*(\d+(?:\.\d+)?)$/;

/** Parses a `data-start` value; `undefined` for an empty or malformed one, which callers read as "not timed". */
export const parseStart = (raw: string | null | undefined): StartExpr | undefined => {
  const text = raw?.trim();
  if (!text) return undefined;
  const n = Number(text);
  if (Number.isFinite(n)) return { kind: "absolute", seconds: Math.max(0, n) };
  const shifted = refShift.exec(text);
  if (shifted?.[1] && shifted[3]) return { kind: "ref", id: shifted[1], offset: (shifted[2] === "-" ? -1 : 1) * Number(shifted[3]) };
  return refId.test(text) ? { kind: "ref", id: text, offset: 0 } : undefined;
};

/** A positive finite number from an attribute, else `undefined`. */
export const positive = (raw: string | null | undefined) => {
  const n = raw == null || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Two times are the same instant when they differ by less than a microsecond (sums of decimal seconds drift). */
export const sameInstant = (a: number, b: number) =>
  Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)) : a === b;

/** A clip shows over the half-open window [start, end). */
export const inWindow = (t: number, start: number, end: number) => (t >= start || sameInstant(t, start)) && t < end && !sameInstant(t, end);

/**
 * Whether a clip shows at `t`: inside its window, or, for a clip that runs to the composition's end (`duration`), also
 * on the final frame, so the last frame is never blank.
 */
export const visibleAt = (t: number, start: number, end: number, duration: number) =>
  inWindow(t, start, end) || ((t >= start || sameInstant(t, start)) && duration > 0 && end >= duration - 1e-6 && sameInstant(t, duration));

/** The frame grid time at or before `t` (render seeks always land on it, so frame n is the same pixels every run). */
export const quantize = (t: number, fps: number) => Math.floor(Math.max(0, t) * fps + 1e-9) / fps;

/** Snaps `x` to the frame grid when it is within a thousandth of a frame of it, so authored 0.1-second windows line up. */
export const snap = (x: number, fps: number) => {
  const frames = x * fps;
  const nearest = Math.round(frames);
  return Math.abs(frames - nearest) <= 1e-3 ? nearest / fps : x;
};

/** The source time a media element plays at `local` seconds into its window. */
export const sourceTime = (local: number, mediaStart: number, rate: number, sourceDuration: number | undefined, loop: boolean) => {
  const raw = mediaStart + Math.max(0, local) * rate;
  if (sourceDuration === undefined || !(sourceDuration > mediaStart)) return raw;
  if (loop) return mediaStart + ((raw - mediaStart) % (sourceDuration - mediaStart));
  return Math.min(raw, sourceDuration);
};

/** A media element's playback rate: `data-playback-rate`, clamped to [0.1, 10], else 1. */
export const playbackRate = (raw: string | null | undefined) => {
  const n = Number.parseFloat(raw ?? "");
  return Number.isFinite(n) && n > 0 ? Math.min(10, Math.max(0.1, n)) : 1;
};
