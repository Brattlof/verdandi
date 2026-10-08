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
