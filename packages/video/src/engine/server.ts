/**
 * Serves a project folder to Chrome on 127.0.0.1, never `file://` (fetch, modules and media ranges need HTTP). HTML
 * pages get the runtime injected at the start of `<head>`, before any author script; a render also gets its clock and
 * fps first. Paths outside the project are refused.
 */
import { realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runtimeScript, virtualTimeScript } from "./bundle.ts";

export type ServeOptions = {
  /** Render mode: frozen clock, frame-grid seeks, media never plays. */
  readonly render?: { readonly fps: number; readonly variables?: Record<string, unknown> };
  /** Extra folders served under `/__vd/<name>/` (extracted video frames). */
  readonly mounts?: Readonly<Record<string, string>>;
};

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};

/** `child` when it lies inside `root`, else `undefined`. */
const inside = (root: string, child: string) => {
  const rel = relative(root, child);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? child : undefined;
};

/** The injected `<head>` prelude for a page. */
export const prelude = async (options: ServeOptions) => {
  const render = options.render
    ? `<script>window.__vdRender=${JSON.stringify({ fps: options.render.fps })};window.__vdVariables=${JSON.stringify(options.render.variables ?? {}).replaceAll("<", "\\u003c")};</script><script>${await virtualTimeScript()}</script>`
    : "";
  return `${render}<script>${await runtimeScript()}</script>`;
};

const inject = (html: string, head: string) => {
  const at = (m: RegExpExecArray, text: string) => {
    const i = m.index + m[0].length;
    return `${html.slice(0, i)}${text}${html.slice(i)}`;
  };
  const open = /<head[^>]*>/i.exec(html);
  if (open) return at(open, head);
  const doc = /<html[^>]*>/i.exec(html);
  return doc ? at(doc, `<head>${head}</head>`) : `${head}${html}`;
};

/** A file response honouring a single `Range` (video seeking needs it). */
const fileResponse = (path: string, range: string | null) => {
  const file = Bun.file(path);
  const type = types[extname(path).toLowerCase()] ?? file.type;
  const size = file.size;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (!m) return new Response(file, { headers: { "content-type": type, "accept-ranges": "bytes" } });
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      "content-type": type,
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": String(end - start + 1),
    },
  });
};

/** Starts the server; `url` is its origin, `stop` shuts it down. */
export const serveProject = async (projectDir: string, options: ServeOptions = {}) => {
  const root = realpathSync(resolve(projectDir));
  const head = await prelude(options);
  const mounts = Object.entries(options.mounts ?? {});
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const mount = mounts.find(([name]) => path.startsWith(`/__vd/${name}/`));
      const base = mount ? mount[1] : root;
      const target = inside(base, join(base, mount ? path.slice(`/__vd/${mount[0]}/`.length) : path === "/" ? "index.html" : path));
      if (!target) return new Response("Forbidden", { status: 403 });
      let real: string;
      try {
        real = realpathSync(target);
      } catch {
        return new Response("Not found", { status: 404 });
      }
      if (!inside(realpathSync(base), real)) return new Response("Forbidden", { status: 403 });
      if (!(await Bun.file(real).exists())) return new Response("Not found", { status: 404 });
      // Only a page (or a player's iframe) gets the runtime: sub-composition files are fetched and mounted by it.
      const dest = req.headers.get("sec-fetch-dest");
      if (extname(real).toLowerCase() === ".html" && (dest === "document" || dest === "iframe"))
        return new Response(inject(await Bun.file(real).text(), head), { headers: { "content-type": types[".html"] ?? "text/html" } });
      return fileResponse(real, req.headers.get("range"));
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
};
