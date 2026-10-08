/** Scaffolds a video project: the root composition, GSAP vendored for offline renders, and a guide for agents. */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gsapPath } from "../engine/bundle.ts";

export const resolutions = {
  landscape: [1920, 1080],
  portrait: [1080, 1920],
  square: [1080, 1080],
  "landscape-4k": [3840, 2160],
  "portrait-4k": [2160, 3840],
  "square-4k": [2160, 2160],
} as const;
export type Resolution = keyof typeof resolutions;

const templates = join(import.meta.dir, "templates");

/** Rewrites the template's canvas size everywhere it is stated: the root's attributes, the page CSS and the viewport. */
export const resize = (html: string, width: number, height: number) =>
  html
    .replace(/data-width="\d+"/g, `data-width="${width}"`)
    .replace(/data-height="\d+"/g, `data-height="${height}"`)
    .replace(/width: 1920px; height: 1080px/g, `width: ${width}px; height: ${height}px`)
    .replace(/content="width=\d+, height=\d+"/, `content="width=${width}, height=${height}"`);

/** Creates `dir` as a new project. Refuses a folder that already has files in it, so nothing is overwritten. */
export const initProject = (dir: string, options: { readonly resolution?: Resolution } = {}) => {
  const target = resolve(dir);
  if (existsSync(target) && readdirSync(target).length)
    throw new Error(`${target} isn't empty. Pick a new folder name, or empty it first.`);
  const [width, height] = resolutions[options.resolution ?? "landscape"];
  mkdirSync(join(target, "vendor"), { recursive: true });
  mkdirSync(join(target, "assets"), { recursive: true });
  mkdirSync(join(target, "compositions"), { recursive: true });
  writeFileSync(join(target, "index.html"), resize(readFileSync(join(templates, "blank", "index.html"), "utf8"), width, height));
  copyFileSync(gsapPath(), join(target, "vendor", "gsap.min.js"));
  copyFileSync(join(templates, "project-guide.md"), join(target, "AGENTS.md"));
  writeFileSync(join(target, ".gitignore"), "renders/\nsnapshots/\n");
  return { dir: target, width, height };
};
