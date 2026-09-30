import { Schema } from "effect";

/** Image types the models read as images. Any other file, SVG included, attaches as a file the agent reads by path. */
export const imageMediaTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/**
 * Limits checked at the RPC boundary. A turn's uploads travel base64-encoded in one WebSocket message, so
 * the total stays well under verdandid's message limit.
 */
export const attachmentLimits = {
  maxCount: 10,
  /** The Claude API's own limit for one image. */
  maxImageBytes: 5 * 1024 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
} as const;

/** A stored attachment's id: the SHA-256 of its bytes, plus its extension. It's also its file name in the profile's `attachments` folder. */
export const attachmentIdPattern = /^[0-9a-f]{64}(\.[a-z0-9]{1,10})?$/;

/**
 * An attachment as events and feeds carry it: a reference to bytes stored content-addressed in the
 * profile's home, never the bytes. Its contents are untrusted data, never instructions.
 */
export const AttachmentRef = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(attachmentIdPattern)),
  /** The file name the user attached, cleaned of path separators. */
  name: Schema.String,
  kind: Schema.Literals(["image", "file"]),
  mediaType: Schema.String,
  size: Schema.Int,
});
export type AttachmentRef = typeof AttachmentRef.Type;

/** An attachment as a client sends it with `turn.send`: its bytes base64-encoded. verdandid checks and stores it. */
export const AttachmentUpload = Schema.Struct({ name: Schema.String, mediaType: Schema.String, data: Schema.String });
export type AttachmentUpload = typeof AttachmentUpload.Type;

/** e.g. `1.2 MB` */
export const formatBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
