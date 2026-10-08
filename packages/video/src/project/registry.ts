/**
 * Blocks: ready-made sub-compositions shipped with Verdandi (`packages/video/registry/<name>/`), each a `block.json`
 * and a `<name>.html` wrapped in `<template>`, plus any assets it lists. `add` copies one into a project's
 * `compositions/` (assets into `assets/<name>/`) and returns the host element that mounts it.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const registryDir = join(import.meta.dir, "../../registry");

export type Block = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  /** Seconds it runs, and the canvas it was designed for. */
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  /** Its `data-composition-variables` declarations, for `--vars` and the mount snippet. */
  readonly variables?: readonly { readonly id: string; readonly type: string; readonly label: string; readonly default: unknown }[];
  /** Files besides `<name>.html`, relative to the block's folder. */
  readonly assets?: readonly string[];
};

const read = (name: string): Block | undefined => {
  const file = join(registryDir, name, "block.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Block) : undefined;
};

export const listBlocks = (): Block[] =>
  readdirSync(registryDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => read(d.name) ?? [])
    .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Blocks matching `query`, best first: every word must appear in the name, title, description or tags; name and tag
 * hits rank above description hits.
 */
export const searchBlocks = (query: string) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return listBlocks()
    .map((b) => {
      const strong = `${b.name} ${b.tags.join(" ")}`.toLowerCase();
      const weak = `${b.title} ${b.description}`.toLowerCase();
      const hits = words.map((w) => (strong.includes(w) ? 2 : weak.includes(w) ? 1 : 0));
      return { b, score: hits.includes(0) ? 0 : hits.reduce<number>((a, n) => a + n, 0) };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || x.b.name.localeCompare(y.b.name))
    .map((x) => x.b);
};

/** The host element that mounts `block`, to paste into a composition and time with `data-start`. */
export const mountSnippet = (block: Block, values?: Record<string, unknown>) => {
  const vars = values && Object.keys(values).length ? ` data-variable-values='${JSON.stringify(values).replaceAll("'", "&#39;")}'` : "";
  return `<div id="${block.name}" class="clip" data-composition-id="${block.name}" data-composition-src="compositions/${block.name}.html" data-start="0" data-duration="${block.duration}" data-track-index="1" style="inset: 0"${vars}></div>`;
};

/**
 * Copies `name` into `projectDir`. Refuses to overwrite a file that is already there unless `force`, so an edited
 * block is never lost; returns the files written and the mount snippet.
 */
export const addBlock = (
  projectDir: string,
  name: string,
  options: { readonly force?: boolean; readonly values?: Record<string, unknown> } = {},
) => {
  const block = read(name);
  if (!block) {
    // A typo misses every word as typed, so suggest blocks sharing any word of the name.
    const parts = name
      .toLowerCase()
      .split(/[-_\s]+/)
      .filter((p) => p.length >= 3);
    const near = listBlocks()
      .filter((b) => parts.some((p) => b.name.includes(p)))
      .slice(0, 3)
      .map((b) => b.name);
    throw new Error(
      `No block named "${name}".${near.length ? ` Did you mean ${near.join(", ")}?` : ""} List them with verdandi video catalog.`,
    );
  }
  const root = resolve(projectDir);
  if (!existsSync(join(root, "index.html")))
    throw new Error(`${root} has no index.html. Run this in a video project (verdandi video init).`);
  const copies = [
    [join(registryDir, name, `${name}.html`), join(root, "compositions", `${name}.html`)],
    ...(block.assets ?? []).map((a) => [join(registryDir, name, a), join(root, "assets", name, a)]),
  ] as const;
  const clash = copies.filter(([, to]) => existsSync(to)).map(([, to]) => to);
  if (clash.length && !options.force)
    throw new Error(`Already in the project: ${clash.join(", ")}. Pass --force to replace it (your edits to it are lost).`);
  for (const [from, to] of copies) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  return { block, files: copies.map(([, to]) => to), snippet: mountSnippet(block, options.values) };
};
