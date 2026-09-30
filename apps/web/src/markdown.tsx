import { createElement, memo, type ReactNode } from "react";

/*
 * Agent text is untrusted, so Markdown becomes React elements and never HTML: raw HTML shows as text,
 * links open only http(s) and mailto, and remote images show their alt text and URL instead of loading.
 * ponytail: a CommonMark subset (no setext headings, indented code, reference links or lazy list lines),
 * upgrade to a parser dependency when real replies render wrong.
 */

/** Renders a reply. While it streams, only the block still being written re-renders. */
export const Markdown = ({ text }: { text: string }) =>
  splitBlocks(text).map((block, i) => (
    // Blocks only append while a reply streams, so the index is a stable key.
    // biome-ignore lint/suspicious/noArrayIndexKey: see above.
    <Block key={i} text={block} />
  ));

const Block = memo(({ text }: { text: string }) => blocks(text.split("\n")));

type Fence = { readonly marker: string; readonly lang: string };
// A backtick fence's info string can't contain a backtick, so "```x```" stays inline code.
const openFence = (line: string): Fence | undefined => {
  const m = /^\s*(?:(`{3,})([^`]*)|(~{3,})(.*))$/.exec(line);
  const marker = m?.[1] ?? m?.[3];
  return marker ? { marker, lang: (m?.[2] ?? m?.[4] ?? "").trim().split(/\s/)[0] ?? "" } : undefined;
};
const closesFence = (line: string, { marker }: Fence) => {
  const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1];
  return close !== undefined && close[0] === marker[0] && close.length >= marker.length;
};

/** Splits text at blank lines outside fenced code. Earlier blocks keep their text as more arrives. */
export const splitBlocks = (text: string) => {
  const out: string[] = [];
  let lines: string[] = [];
  let fence: Fence | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!fence && line.trim() === "") {
      if (lines.length > 0) out.push(lines.join("\n"));
      lines = [];
      continue;
    }
    lines.push(line);
    fence = fence ? (closesFence(line, fence) ? undefined : fence) : openFence(line);
  }
  if (lines.length > 0) out.push(lines.join("\n"));
  return out;
};

/** A block that starts at line `i`: what it renders and the line after it. */
type Parser = (lines: readonly string[], i: number) => readonly [ReactNode, number] | undefined;

const fenced: Parser = (lines, i) => {
  const fence = openFence(lines[i] ?? "");
  if (!fence) return;
  const close = lines.findIndex((line, j) => j > i && closesFence(line, fence));
  const end = close === -1 ? lines.length : close;
  const code = <code data-language={fence.lang || undefined}>{lines.slice(i + 1, end).join("\n")}</code>;
  return [<pre key={i}>{code}</pre>, close === -1 ? end : end + 1];
};

const heading: Parser = (lines, i) => {
  const m = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(lines[i] ?? "");
  return m ? [createElement(`h${m[1]?.length}`, { key: i }, inline(m[2] ?? "")), i + 1] : undefined;
};

const rule: Parser = (lines, i) => (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(lines[i] ?? "") ? [<hr key={i} />, i + 1] : undefined);

const quote: Parser = (lines, i) => {
  let j = i;
  while (/^ {0,3}>/.test(lines[j] ?? "")) j++;
  if (j === i) return;
  const text = lines.slice(i, j).map((line) => line.replace(/^ {0,3}> ?/, ""));
  return [
    <blockquote key={i}>
      <Markdown text={text.join("\n")} />
    </blockquote>,
    j,
  ];
};

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
const isDelimiter = (line = "") => line.includes("|") && cells(line).every((cell) => /^:?-+:?$/.test(cell));
const alignOf = (cell: string) =>
  cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") : cell.startsWith(":") ? "left" : undefined;

const table: Parser = (lines, i) => {
  if (!lines[i]?.includes("|") || !isDelimiter(lines[i + 1])) return;
  const header = cells(lines[i] ?? "");
  const align = cells(lines[i + 1] ?? "").map(alignOf);
  let j = i + 2;
  while (lines[j]?.includes("|")) j++;
  const row = (values: readonly string[], Cell: "th" | "td") =>
    header.map((_, k) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional, so their index is their identity.
      <Cell key={k} style={{ textAlign: align[k] }}>
        {inline(values[k] ?? "")}
      </Cell>
    ));
  return [
    <table key={i}>
      <thead>
        <tr>{row(header, "th")}</tr>
      </thead>
      <tbody>
        {lines.slice(i + 2, j).map((line, n) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional too.
          <tr key={n}>{row(cells(line), "td")}</tr>
        ))}
      </tbody>
    </table>,
    j,
  ];
};

const listItem = /^( *)([-*+]|\d{1,9}[.)])( +|$)/;

const list: Parser = (lines, i) => {
  const first = listItem.exec(lines[i] ?? "");
  if (!first) return;
  const indent = first[1]?.length ?? 0;
  const ordered = /\d/.test(first[2] ?? "");
  const items: { line: number; width: number; text: string[] }[] = [];
  let fence: Fence | undefined;
  let j = i;
  for (; j < lines.length; j++) {
    const line = lines[j] ?? "";
    const m = fence ? null : listItem.exec(line);
    const current = items.at(-1);
    if (m && m[1]?.length === indent && /\d/.test(m[2] ?? "") === ordered) {
      items.push({ line: j, width: m[0].length, text: [line.slice(m[0].length)] });
    } else if (current && (fence || line.length - line.trimStart().length > indent)) {
      // Continuation lines, nested lists included, are indented under their item's text.
      current.text.push(line.slice(Math.min(line.length - line.trimStart().length, current.width)));
    } else break;
    const text = items.at(-1)?.text.at(-1) ?? "";
    fence = fence ? (closesFence(text, fence) ? undefined : fence) : openFence(text);
  }
  const start = Number.parseInt(first[2] ?? "", 10);
  return [
    createElement(
      ordered ? "ol" : "ul",
      { key: i, start: ordered && start !== 1 ? start : undefined },
      items.map((item) => (
        <li key={item.line}>
          <Markdown text={item.text.join("\n")} />
        </li>
      )),
    ),
    j,
  ];
};

const parsers = [fenced, heading, rule, quote, table, list];
const parseAt = (lines: readonly string[], i: number) => {
  for (const parse of parsers) {
    const hit = parse(lines, i);
    if (hit) return hit;
  }
};

/** Lines no other block claims form a paragraph. Line breaks are kept, as the terminal shows them. */
const blocks = (lines: readonly string[]) => {
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; ) {
    const hit = parseAt(lines, i);
    if (hit) {
      out.push(hit[0]);
      i = hit[1];
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !parseAt(lines, j)) j++;
    const text = lines.slice(i, j).map((line) => line.trim());
    out.push(<p key={i}>{inline(text.join("\n"))}</p>);
    i = j;
  }
  return out;
};

type Groups = Readonly<Record<string, string | undefined>>;

// Tried left to right at each position. Link URLs may hold one level of parentheses. Underscores mark emphasis only outside words, so snake_case stays.
const inlinePattern = new RegExp(
  [
    /(?<tick>`+)(?<code>[\s\S]+?)\k<tick>(?!`)/u,
    /!\[(?<alt>[^\]]*)\]\((?<src>(?:[^\s()]|\([^\s()]*\))*)[^)]*\)/u,
    /\[(?<label>[^\]]+)\]\((?<href>(?:[^\s()]|\([^\s()]*\))*)[^)]*\)/u,
    /<(?<auto>https?:\/\/[^\s>]+)>/u,
    /(?<bare>https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]*_~])/u,
    /\*\*(?<strong>[^\s*](?:[\s\S]*?\S)?)\*\*/u,
    /(?<![\p{L}\p{N}_])__(?<strong_>[^\s_](?:[\s\S]*?\S)?)__(?![\p{L}\p{N}_])/u,
    /~~(?<del>[^\s~](?:[\s\S]*?\S)?)~~/u,
    /\*(?<em>[^\s*](?:[\s\S]*?[^\s*])?)\*/u,
    /(?<![\p{L}\p{N}_])_(?<em_>[^\s_](?:[\s\S]*?[^\s_])?)_(?![\p{L}\p{N}_])/u,
    /\\(?<escaped>[!-/:-@[-`{-~])/u,
  ]
    .map((part) => part.source)
    .join("|"),
  "gu",
);

const link = (href: string, label: ReactNode, key: number) =>
  /^(?:https?:|mailto:)/i.test(href) ? (
    <a key={key} href={href} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  ) : (
    <span key={key} title={href}>
      {label}
    </span>
  );

/** One renderer per inline mark, keyed by the pattern group that holds its content. */
const marks: Record<string, (g: Groups, key: number, inLink: boolean) => ReactNode> = {
  code: (g, key) => <code key={key}>{g.code}</code>,
  src: (g, key) => (
    <span key={key} className="image" title="Remote images are not loaded">
      [image: {g.alt}] {g.src}
    </span>
  ),
  href: (g, key) => link(g.href ?? "", inline(g.label ?? "", true), key),
  auto: (g, key) => link(g.auto ?? "", g.auto, key),
  bare: (g, key) => link(g.bare ?? "", g.bare, key),
  strong: (g, key, inLink) => <strong key={key}>{inline(g.strong ?? "", inLink)}</strong>,
  strong_: (g, key, inLink) => <strong key={key}>{inline(g.strong_ ?? "", inLink)}</strong>,
  del: (g, key, inLink) => <del key={key}>{inline(g.del ?? "", inLink)}</del>,
  em: (g, key, inLink) => <em key={key}>{inline(g.em ?? "", inLink)}</em>,
  em_: (g, key, inLink) => <em key={key}>{inline(g.em_ ?? "", inLink)}</em>,
  escaped: (g) => g.escaped,
};
const kinds = Object.keys(marks);
const linkKinds = new Set(["href", "auto", "bare"]);

/** A link's label holds no links, since an anchor can't contain another. */
const inline = (text: string, inLink = false) => {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(inlinePattern)) {
    const groups = m.groups ?? {};
    const kind = kinds.find((k) => groups[k] !== undefined) ?? "";
    out.push(text.slice(last, m.index));
    out.push(inLink && linkKinds.has(kind) ? m[0] : marks[kind]?.(groups, m.index, inLink));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
};
