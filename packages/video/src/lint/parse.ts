/**
 * A composition file as lint reads it: its elements in document order with attributes, parent and line, and the text
 * of its scripts and styles. Parsed with Bun's HTMLRewriter (lol-html), so `<template>` content is walked like any
 * other markup. Comments are blanked first (offsets kept), so markup inside them is never linted.
 */

export type Tag = {
  readonly index: number;
  readonly name: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly parent: number | undefined;
  /** Written as `<tag … />`, which browsers ignore for non-void elements. */
  readonly selfClosing: boolean;
  readonly line: number;
};

export type Block = { readonly tag: number; readonly text: string; readonly line: number };

export type ParsedFile = {
  readonly source: string;
  readonly tags: readonly Tag[];
  readonly scripts: readonly Block[];
  readonly styles: readonly Block[];
};

/** `source` with every `<!-- … -->` replaced by spaces (newlines kept), so offsets and lines still match. */
export const blankComments = (source: string) => source.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));

const lineAt = (source: string, offset: number) => {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
};

/** Offsets of every `<name` opening tag, per tag name, in order, outside comments and raw-text blocks. */
const openings = (source: string) => {
  const byName = new Map<string, number[]>();
  const raw = /<(script|style)\b[\s\S]*?<\/\1\s*>/gi;
  const masked = source.replace(raw, (block) => {
    const open = block.indexOf(">") + 1;
    return block.slice(0, open) + block.slice(open).replace(/[^\n]/g, " ");
  });
  for (const m of masked.matchAll(/<([a-zA-Z][\w-]*)(?=[\s/>])/g)) {
    const name = m[1]?.toLowerCase() ?? "";
    const list = byName.get(name) ?? [];
    list.push(m.index);
    byName.set(name, list);
  }
  return byName;
};

export const parseFile = async (raw: string): Promise<ParsedFile> => {
  const source = blankComments(raw);
  const offsets = openings(source);
  const seen = new Map<string, number>();
  const tags: Tag[] = [];
  const scripts: Block[] = [];
  const styles: Block[] = [];
  const stack: number[] = [];
  let current: { kind: "script" | "style"; tag: number; text: string } | undefined;
  const flush = () => {
    if (!current) return;
    const tag = tags[current.tag];
    (current.kind === "script" ? scripts : styles).push({ tag: current.tag, text: current.text, line: tag?.line ?? 1 });
    current = undefined;
  };
  await new HTMLRewriter()
    .on("*", {
      element(el) {
        flush();
        const name = el.tagName.toLowerCase();
        const n = seen.get(name) ?? 0;
        seen.set(name, n + 1);
        const offset = offsets.get(name)?.[n];
        const index = tags.length;
        tags.push({
          index,
          name,
          attrs: new Map([...el.attributes].map(([k, v]) => [k.toLowerCase(), v])),
          parent: stack.at(-1),
          selfClosing: el.selfClosing,
          line: offset === undefined ? 1 : lineAt(source, offset),
        });
        if (name === "script" || name === "style") current = { kind: name, tag: index, text: "" };
        if (el.canHaveContent && !el.selfClosing) {
          stack.push(index);
          el.onEndTag(() => {
            if (current?.tag === index) flush();
            stack.pop();
          });
        }
      },
    })
    .on("script, style", {
      text(t) {
        if (current) current.text += t.text;
      },
    })
    .transform(new Response(source))
    .text();
  flush();
  return { source, tags, scripts, styles };
};

/** The tag's ancestors, nearest first. */
export const ancestors = (file: ParsedFile, tag: Tag) => {
  const out: Tag[] = [];
  for (let p = tag.parent; p !== undefined; p = file.tags[p]?.parent) {
    const t = file.tags[p];
    if (t) out.push(t);
  }
  return out;
};

/** Script text with comments and string/template literals blanked, so patterns match code, not prose. */
export const codeOnly = (js: string) =>
  js.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) =>
    m.startsWith("/") ? m.replace(/[^\n]/g, " ") : `${m[0]}${" ".repeat(Math.max(0, m.length - 2))}${m.at(-1)}`,
  );
