/**
 * Edits one attribute of one element in a composition's source text, by the element's id, leaving every other byte
 * as it was: a timeline drag must not reformat the file an agent or a person wrote.
 */

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The span of the opening tag carrying `id="<id>"` (outside comments), or undefined. */
export const findTag = (source: string, id: string) => {
  const comments = [...source.matchAll(/<!--[\s\S]*?-->/g)].map((m) => [m.index, m.index + m[0].length] as const);
  const re = new RegExp(`<[a-zA-Z][\\w-]*(?=[^>]*\\sid\\s*=\\s*(["'])${escapeRegex(id)}\\1)[^>]*>`, "g");
  for (const m of source.matchAll(re))
    if (!comments.some(([a, b]) => m.index >= a && m.index < b)) return { start: m.index, end: m.index + m[0].length };
  return undefined;
};

/**
 * `source` with attribute `name` of the element with id `id` set to `value` (or removed, for `null`; written bare, for
 * `""`). Undefined when no element has that id, so the caller says so instead of writing nothing silently.
 */
export const setAttribute = (source: string, id: string, name: string, value: string | null) => {
  const span = findTag(source, id);
  if (!span) return undefined;
  const tag = source.slice(span.start, span.end);
  const attr = new RegExp(`(\\s)${escapeRegex(name)}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?(?=[\\s/>])`);
  const quoted = value === null ? "" : value === "" ? ` ${name}` : ` ${name}="${value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`;
  let next: string;
  if (attr.test(tag))
    next = value === null ? tag.replace(attr, "") : tag.replace(attr, (_m, space: string) => `${space}${quoted.trimStart()}`);
  else if (value === null) return source;
  else next = tag.replace(/\s*(\/?)>$/, (_m, slash: string) => `${quoted}${slash ? " /" : ""}>`);
  return source.slice(0, span.start) + next + source.slice(span.end);
};

/** Seconds as an attribute value: at most three decimals, no trailing zeros. */
export const seconds = (s: number) => String(Math.round(s * 1000) / 1000);

/** `source` with `markup` inserted as the first child of the composition `compositionId`, or undefined without one. */
export const insertIntoComposition = (source: string, compositionId: string, markup: string) => {
  const open = new RegExp(`<[a-zA-Z][\\w-]*(?=[^>]*\\sdata-composition-id\\s*=\\s*(["'])${escapeRegex(compositionId)}\\1)[^>]*>`).exec(
    source,
  );
  if (!open) return undefined;
  const at = open.index + open[0].length;
  const indent = /\n([ \t]*)[^\n]*$/.exec(source.slice(0, open.index))?.[1] ?? "";
  // The file's own line ending: a Windows checkout's CRLF stays CRLF.
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  return `${source.slice(0, at)}${eol}${indent}  ${markup}${source.slice(at)}`;
};

const kinds = { video: /\.(?:mp4|webm|mov|m4v)$/i, audio: /\.(?:mp3|wav|m4a|aac|ogg)$/i } as const;

/** The element that plays `asset` from `start` on `track`, with an id not in `taken`. */
export const assetMarkup = (asset: string, start: number, track: number, taken: ReadonlySet<string>) => {
  const stem =
    (asset.split("/").pop() ?? "asset")
      .replace(/\.[^.]+$/, "")
      .replace(/[^\w-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "asset";
  let id = /^[A-Za-z]/.test(stem) ? stem : `asset-${stem}`;
  for (let n = 2; taken.has(id); n++) id = `${stem}-${n}`;
  const timing = `data-start="${seconds(start)}" data-track-index="${track}"`;
  if (kinds.video.test(asset))
    return {
      id,
      markup: `<video id="${id}" class="clip" src="${asset}" muted ${timing} style="inset: 0; width: 100%; height: 100%; object-fit: cover"></video>`,
    };
  if (kinds.audio.test(asset)) return { id, markup: `<audio id="${id}" src="${asset}" ${timing}></audio>` };
  return {
    id,
    markup: `<img id="${id}" class="clip" src="${asset}" alt="" ${timing} data-duration="3" style="inset: 0; width: 100%; height: 100%; object-fit: contain">`,
  };
};
