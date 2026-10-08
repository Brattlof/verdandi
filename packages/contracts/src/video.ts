import { Schema } from "effect";

/**
 * A video project open in the Studio (DESIGN §24). The id is also the capability in its preview URL
 * (`/video/<id>/…`): 256 random bits, known only to clients that opened the project, and forgotten when verdandid stops.
 */
export const VideoProjectId = Schema.String.pipe(Schema.brand("VideoProjectId"));
export type VideoProjectId = typeof VideoProjectId.Type;

export const VideoFormat = Schema.Literals(["mp4", "webm", "mov", "gif", "png-sequence"]);
export type VideoFormat = typeof VideoFormat.Type;
export const VideoQuality = Schema.Literals(["draft", "standard", "high"]);
export type VideoQuality = typeof VideoQuality.Type;

/** A render running or finished in this verdandid, with where it is: `stage`, and `done` of `total` frames while capturing. */
export const VideoRenderJob = Schema.Struct({
  jobId: Schema.String,
  status: Schema.Literals(["rendering", "done", "failed", "cancelled"]),
  stage: Schema.String,
  done: Schema.Int,
  total: Schema.Int,
  format: VideoFormat,
  /** The output, relative to the project (`renders/…`), once written. */
  output: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  startedAt: Schema.Number,
});
export type VideoRenderJob = typeof VideoRenderJob.Type;

export const VideoView = Schema.Struct({
  projectId: VideoProjectId,
  /** The project's real path. */
  path: Schema.String,
  /** Text files the Studio can edit, relative to the project, sorted. */
  files: Schema.Array(Schema.String),
  /** Media under `assets/`, relative to the project, sorted. */
  assets: Schema.Array(Schema.String),
  renders: Schema.Array(VideoRenderJob),
});
export type VideoView = typeof VideoView.Type;

/** A file's text and its version (the SHA-256 of its bytes), to write back with `expectedVersion`. */
export const VideoFile = Schema.Struct({ path: Schema.String, content: Schema.String, version: Schema.String });
export type VideoFile = typeof VideoFile.Type;

/** The project, then each change: files changed on disk (by anyone), and every render's progress. */
export const VideoFeed = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("snapshot"), view: VideoView }),
  Schema.Struct({
    kind: Schema.Literal("changed"),
    paths: Schema.Array(Schema.String),
    files: Schema.Array(Schema.String),
    assets: Schema.Array(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("render"), job: VideoRenderJob }),
]);
export type VideoFeed = typeof VideoFeed.Type;

/** Why a video request failed. The message names the cause and the fix; a `Conflict` carries the file as it is now. */
export class VideoUnavailable extends Schema.TaggedError<VideoUnavailable>()("VideoUnavailable", {
  reason: Schema.Literals(["NotAProject", "ProjectNotOpen", "InvalidPath", "FileNotFound", "Conflict", "RenderNotFound"]),
  message: Schema.String,
  current: Schema.optionalKey(VideoFile),
}) {}

/** A timed element as the Studio timeline shows it (`end` null: it runs to the composition's end). */
export const VideoClip = Schema.Struct({
  id: Schema.UndefinedOr(Schema.String),
  label: Schema.String,
  kind: Schema.Literals(["video", "audio", "image", "composition", "element"]),
  start: Schema.Number,
  end: Schema.NullOr(Schema.Number),
  track: Schema.Int,
  hidden: Schema.Boolean,
  compositionId: Schema.UndefinedOr(Schema.String),
});
export type VideoClip = typeof VideoClip.Type;

/** A `<video>` or `<audio>` on the timeline: what a render decodes frames and mixes sound from. */
export const VideoMedia = Schema.Struct({
  renderId: Schema.String,
  kind: Schema.Literals(["video", "audio"]),
  /** Absolute URL of the source, as the page loaded it. */
  src: Schema.String,
  start: Schema.Number,
  end: Schema.Number,
  /** Offset into the source where the clip starts (`data-playback-start`, or legacy `data-media-start`). */
  mediaStart: Schema.Number,
  rate: Schema.Number,
  loop: Schema.Boolean,
  volume: Schema.Number,
  /** Whether its sound goes into the mix: audio always, video unless `muted` or `data-has-audio="false"`. */
  audible: Schema.Boolean,
  /** Hidden with `data-hidden` (or inside a hidden element): neither seen nor heard. */
  hidden: Schema.Boolean,
});
export type VideoMedia = typeof VideoMedia.Type;

/**
 * A slide, for presenting: a scene marked `data-slide`. Presenting plays up to `rest` (its `data-hold` seconds after its
 * start, else just before its end) and waits there for the next step.
 */
export const VideoSlide = Schema.Struct({
  id: Schema.UndefinedOr(Schema.String),
  title: Schema.String,
  start: Schema.Number,
  rest: Schema.Number,
  notes: Schema.String,
});
export type VideoSlide = typeof VideoSlide.Type;

/** A composition's resolved timeline, read from the running page (`window.__vd.manifest()`). */
export const VideoManifest = Schema.Struct({
  id: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  duration: Schema.Number,
  clips: Schema.Array(VideoClip),
  media: Schema.Array(VideoMedia),
  /** Scenes marked `data-slide`, in order; empty for a composition that isn't a slideshow. */
  slides: Schema.Array(VideoSlide),
});
export type VideoManifest = typeof VideoManifest.Type;

/** One lint or check finding: the cause and how to fix it, where it is when known. */
export const VideoFinding = Schema.Struct({
  code: Schema.String,
  severity: Schema.Literals(["error", "warning", "info"]),
  message: Schema.String,
  file: Schema.String,
  line: Schema.optionalKey(Schema.Int),
  fix: Schema.optionalKey(Schema.String),
});
export type VideoFinding = typeof VideoFinding.Type;

/** What `verdandi video check` reports: lint, then (unless lint found errors) the page run in Chrome at `samples`. */
export const VideoCheckResult = Schema.Struct({
  ok: Schema.Boolean,
  errors: Schema.Int,
  warnings: Schema.Int,
  findings: Schema.Array(VideoFinding),
  browserSkipped: Schema.Boolean,
  samples: Schema.Array(Schema.Number),
});
export type VideoCheckResult = typeof VideoCheckResult.Type;
