import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AttachmentRef,
  type AttachmentUpload,
  attachmentIdPattern,
  attachmentLimits,
  CommandRejected,
  formatBytes,
  imageMediaTypes,
} from "@verdandi/contracts";
import { Effect } from "effect";

/** Where a profile keeps attachments, each file named by its id: its content's SHA-256 and extension. */
export const attachmentsDir = (home: string) => join(home, "attachments");

/** The stored bytes of attachment `id`, or undefined for an id that isn't one: ids come from clients, so they're checked. */
export const attachmentPath = (dir: string, id: string) => (attachmentIdPattern.test(id) ? join(dir, id) : undefined);

const invalid = (message: string) => new CommandRejected({ reason: "InvalidAttachment", message });

const imageExtensions: Record<(typeof imageMediaTypes)[number], string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Whether `bytes` start the way an image of `mediaType` does, so a file can't pass as an image it isn't. */
const looksLike = (mediaType: (typeof imageMediaTypes)[number], b: Uint8Array) => {
  const starts = (...sig: number[]) => sig.every((x, i) => b[i] === x);
  return {
    "image/png": () => starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    "image/jpeg": () => starts(0xff, 0xd8, 0xff),
    "image/gif": () => starts(0x47, 0x49, 0x46, 0x38),
    "image/webp": () => starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  }[mediaType]();
};

/** A display name without folders or characters that don't belong in one. */
export const cleanName = (name: string) =>
  (name.split(/[\\/]/).at(-1) ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .trim()
    .slice(0, 120) || "attachment";

const isImageType = (t: string): t is (typeof imageMediaTypes)[number] => (imageMediaTypes as readonly string[]).includes(t);

/**
 * Checks a turn's uploads (count, size, and that an image is the image it claims to be) and stores each
 * content-addressed in `dir`: the same bytes are kept once. A trust boundary: the rejection names the file and the fix.
 */
export const storeAttachments = (dir: string, uploads: readonly AttachmentUpload[]): Effect.Effect<AttachmentRef[], CommandRejected> =>
  Effect.gen(function* () {
    if (uploads.length > attachmentLimits.maxCount) {
      return yield* invalid(
        `A turn takes at most ${attachmentLimits.maxCount} attachments, not ${uploads.length}. Send the rest with the next turn.`,
      );
    }
    const decoded = [];
    for (const u of uploads) {
      const name = cleanName(u.name);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(u.data) || u.data.length % 4 !== 0)
        return yield* invalid(`${name} didn't arrive as base64. Attach it again.`);
      const bytes = new Uint8Array(Buffer.from(u.data, "base64"));
      const image = isImageType(u.mediaType);
      const max = image ? attachmentLimits.maxImageBytes : attachmentLimits.maxFileBytes;
      if (bytes.length > max)
        return yield* invalid(
          `${name} is ${formatBytes(bytes.length)}; ${image ? "an image" : "a file"} can be at most ${formatBytes(max)}.`,
        );
      if (image && !looksLike(u.mediaType as (typeof imageMediaTypes)[number], bytes))
        return yield* invalid(`${name} says it is ${u.mediaType}, but its bytes aren't. Attach the image again, or as a file.`);
      decoded.push({ name, bytes, image, mediaType: image ? u.mediaType : u.mediaType || "application/octet-stream" });
    }
    const total = decoded.reduce((sum, d) => sum + d.bytes.length, 0);
    if (total > attachmentLimits.maxTotalBytes) {
      return yield* invalid(
        `These attachments add up to ${formatBytes(total)}; a turn takes at most ${formatBytes(attachmentLimits.maxTotalBytes)}. Send some with the next turn.`,
      );
    }
    mkdirSync(dir, { recursive: true });
    return decoded.map(({ name, bytes, image, mediaType }): AttachmentRef => {
      const hash = createHash("sha256").update(bytes).digest("hex");
      const ext = image
        ? imageExtensions[mediaType as (typeof imageMediaTypes)[number]]
        : (name.match(/\.([A-Za-z0-9]{1,10})$/)?.[1]?.toLowerCase() ?? "");
      const id = ext ? `${hash}.${ext}` : hash;
      const path = join(dir, id);
      if (!existsSync(path)) {
        // Written aside and renamed, so a crash never leaves a partial file under a content hash.
        const partial = `${path}.${process.pid}.partial`;
        writeFileSync(partial, bytes);
        renameSync(partial, path);
      }
      return { id, name, kind: image ? "image" : "file", mediaType, size: bytes.length };
    });
  });
