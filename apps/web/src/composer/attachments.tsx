import { type AttachmentRef, type AttachmentUpload, attachmentLimits, formatBytes, imageMediaTypes } from "@verdandi/contracts";
import { useEffect, useState } from "react";
import { type Connection, uuid } from "../client.ts";
import { CloseIcon, FileIcon } from "../ui/icons.tsx";

/** An attachment waiting to go with the next turn. `preview` is an object URL for an image's thumbnail. */
export type Pending = AttachmentUpload & { readonly key: string; readonly size: number; readonly preview: string | undefined };

const isImage = (type: string) => (imageMediaTypes as readonly string[]).includes(type);

const read = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/**
 * Reads `files` to go with the next turn after `current`, checked against the limits verdandid enforces, so
 * a file that's too big is caught before it's sent. The error names the file and the limit.
 */
export const addFiles = async (
  files: readonly File[],
  current: readonly Pending[],
): Promise<{ readonly added: Pending[]; readonly error?: string }> => {
  if (current.length + files.length > attachmentLimits.maxCount)
    return { added: [], error: `A turn takes at most ${attachmentLimits.maxCount} attachments.` };
  let total = current.reduce((sum, p) => sum + p.size, 0);
  for (const f of files) {
    const max = isImage(f.type) ? attachmentLimits.maxImageBytes : attachmentLimits.maxFileBytes;
    if (f.size > max) return { added: [], error: `${f.name} is ${formatBytes(f.size)}; the limit is ${formatBytes(max)}.` };
    total += f.size;
  }
  if (total > attachmentLimits.maxTotalBytes)
    return { added: [], error: `A turn's attachments can add up to ${formatBytes(attachmentLimits.maxTotalBytes)} at most.` };
  const added = await Promise.all(
    files.map(async (f) => ({
      key: uuid(),
      name: f.name || "pasted image",
      mediaType: f.type || "application/octet-stream",
      size: f.size,
      data: await read(f),
      preview: isImage(f.type) ? URL.createObjectURL(f) : undefined,
    })),
  );
  return { added };
};

/** The attachments waiting for the next turn, each removable. */
export const PendingList = ({ items, onRemove }: { items: readonly Pending[]; onRemove: (key: string) => void }) =>
  items.length === 0 ? null : (
    <ul aria-label="Attachments for the next turn" className="m-0 flex list-none flex-wrap gap-2 px-3 pt-2.5 pb-0">
      {items.map((p) => (
        <li key={p.key} className="flex items-center gap-1.5 rounded-lg border border-line bg-bg py-1 pr-1 pl-1 text-xs">
          {p.preview ? <img src={p.preview} alt="" className="size-8 rounded object-cover" /> : <FileIcon className="mx-1 text-muted" />}
          <span className="max-w-48 truncate">{p.name}</span>
          <span className="text-muted tabular-nums">{formatBytes(p.size)}</span>
          <button
            type="button"
            className="border-0 bg-transparent px-1 text-muted hover:text-fg"
            aria-label={`Remove ${p.name}`}
            onClick={() => onRemove(p.key)}
          >
            <CloseIcon className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );

/** A turn's attachments: image thumbnails, fetched from verdandid when shown, and files by name. */
export const TurnAttachments = ({ connection, attachments }: { connection: Connection; attachments: readonly AttachmentRef[] }) =>
  attachments.length === 0 ? null : (
    <ul aria-label="Attachments" className="m-0 mt-1 flex list-none flex-wrap gap-2 p-0">
      {attachments.map((a) => (
        <li key={a.id + a.name}>
          {a.kind === "image" ? (
            <Thumbnail connection={connection} attachment={a} />
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 text-xs">
              <FileIcon className="size-3.5 text-muted" />
              {a.name} <span className="text-muted">{formatBytes(a.size)}</span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );

const Thumbnail = ({ connection, attachment }: { connection: Connection; attachment: AttachmentRef }) => {
  const [src, setSrc] = useState<string | undefined | null>(null);
  useEffect(() => {
    let current = true;
    void connection.attachmentUrl(attachment.id).then((url) => current && setSrc(url));
    return () => {
      current = false;
    };
  }, [connection, attachment.id]);
  if (src === null)
    return <span role="img" className="inline-block h-24 w-32 rounded-md border border-line bg-bg" aria-label={attachment.name} />;
  if (src === undefined) return <span className="text-xs text-error">{attachment.name} couldn't be loaded</span>;
  return (
    <a href={src} target="_blank" rel="noreferrer" title={`${attachment.name}, ${formatBytes(attachment.size)}`}>
      <img src={src} alt={attachment.name} className="max-h-24 max-w-48 rounded-md border border-line object-contain" />
    </a>
  );
};
