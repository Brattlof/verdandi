/**
 * Renders a composition to a file: serve the project with the render clock, open it in headless Chrome, decode its
 * videos and mix its audio with ffmpeg, then seek every frame, paint the video frames, screenshot, and stream the
 * screenshots into the encoder.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { Page } from "puppeteer-core";
import type { Manifest } from "../runtime/player.ts";
import { mixAudio } from "./audio.ts";
import { type Env, launchBrowser, openComposition } from "./browser.ts";
import { audioArgs, type Format, gifArgs, hasAlpha, type Quality, videoArgs } from "./encode.ts";
import { ffmpegPath, runFfmpeg } from "./ffmpeg.ts";
import { type ExtractedVideo, extractVideos, frameFile } from "./frames.ts";
import { serveProject } from "./server.ts";

export type RenderStage = "open" | "extract" | "audio" | "capture" | "encode";
export type RenderProgress = { readonly stage: RenderStage; readonly done: number; readonly total: number };

export type RenderOptions = {
  readonly projectDir: string;
  /** The page to render, relative to the project (default `index.html`). */
  readonly entry?: string;
  readonly output: string;
  readonly format?: Format;
  readonly quality?: Quality;
  readonly fps?: number;
  readonly crf?: number;
  /** Chrome processes capturing at once (default: `defaultWorkers`). */
  readonly workers?: number;
  /** Variable overrides for the root composition (and defaults for sub-compositions). */
  readonly variables?: Record<string, unknown>;
  /** Environment for Chrome and ffmpeg: the caller's, without Verdandi's secrets. */
  readonly env: Env;
  readonly signal?: AbortSignal;
  readonly onProgress?: (p: RenderProgress) => void;
};

export type RenderResult = {
  readonly output: string;
  readonly frames: number;
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  /** Chrome processes that captured. */
  readonly workers: number;
  readonly timings: Readonly<Record<RenderStage, number>>;
};

/** Maps a URL the page used back to a local file: the project's own, or a remote one downloaded into `work`. */
const sourceResolver = (base: string, projectDir: string, work: string) => {
  const downloads = new Map<string, string>();
  const local = (url: string) => {
    const u = new URL(url);
    if (u.origin !== base) return downloads.get(url);
    const file = resolve(projectDir, `.${decodeURIComponent(u.pathname)}`);
    const rel = relative(projectDir, file);
    return rel.startsWith("..") ? undefined : file;
  };
  const fetchRemote = async (urls: readonly string[]) => {
    for (const url of urls) {
      if (downloads.has(url) || !/^https?:/.test(url) || new URL(url).origin === base) continue;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not download ${url}: HTTP ${res.status}. Save the file into the project instead.`);
      const file = join(work, "downloads", `${downloads.size}-${new URL(url).pathname.split("/").pop() || "media"}`);
      mkdirSync(dirname(file), { recursive: true });
      await Bun.write(file, res);
      downloads.set(url, file);
    }
  };
  return { local, fetchRemote };
};

/** Seeks `page` to `t` and paints each active video's decoded frame over its `<video>`. */
const drawAt = async (page: Page, t: number, videos: ReadonlyMap<string, ExtractedVideo>, base: string) => {
  const targets = await page.evaluate(async (time) => {
    await window.__vd?.seek(time);
    return window.__vd?.frameTargets(time) ?? [];
  }, t);
  if (!targets.length && !videos.size) return;
  const paint = targets.flatMap((target) => {
    const v = videos.get(target.renderId);
    return v ? [{ renderId: target.renderId, url: `${base}/__vd/frames/${target.renderId}/${frameFile(v, target.sourceTime)}` }] : [];
  });
  await page.evaluate((list) => window.__vd?.paintFrames(list), paint);
};

type Shot = Parameters<Page["screenshot"]>[0] & { readonly type: "png" | "jpeg" };

/**
 * One frame's picture at `t`: drawn, then for a shader transition captured twice more, once per side with the other
 * hidden, and blended on the page's WebGL canvas before the final capture.
 */
// ponytail: one shader transition per frame (the first); two overlapping ones would need a blend per pair.
const captureAt = async (page: Page, t: number, videos: ReadonlyMap<string, ExtractedVideo>, base: string, options: Shot) => {
  // Puppeteer captures beyond the viewport by default, which resizes the page for each screenshot: Chrome lays it out
  // and paints it again mid-capture, and a heavy frame comes out with whole layers missing. Frames are the viewport.
  const shot = { ...options, captureBeyondViewport: false };
  await drawAt(page, t, videos, base);
  const [active] = await page.evaluate((time) => window.__vd?.transitionsAt(time) ?? [], t);
  if (!active) return page.screenshot(shot);
  const side = async (hide: string) => {
    await page.evaluate((id) => window.__vd?.isolate([id]), hide);
    try {
      return await page.screenshot({ ...shot, encoding: "base64" });
    } finally {
      await page.evaluate(() => window.__vd?.restore());
    }
  };
  const mime = shot.type === "png" ? "image/png" : "image/jpeg";
  const [from, to] = [await side(active.to), await side(active.from)];
  await page.evaluate((o) => window.__vd?.composite(o), {
    shader: active.shader,
    progress: active.progress,
    from: `data:${mime};base64,${from}`,
    to: `data:${mime};base64,${to}`,
  });
  try {
    return await page.screenshot(shot);
  } finally {
    await page.evaluate(() => window.__vd?.clearComposite());
  }
};

/**
 * How many Chrome processes capture at once: one per three cores, at most four (separate browsers scale; tabs in one
 * barely do), and one for a short render, where starting browsers costs more than it saves.
 */
// ponytail: a fixed core-count heuristic; upgrade to measuring capture cost per frame when renders get long or heavy.
export const defaultWorkers = (frames: number, cpus = navigator.hardwareConcurrency) =>
  frames < 90 ? 1 : Math.max(1, Math.min(4, Math.floor(cpus / 3)));

/**
 * Hands frames to `write` in order, whatever order workers finish them in. A worker more than `window` frames ahead of
 * the writer waits, so memory stays bounded.
 */
export const orderedWriter = (write: (frame: Uint8Array, index: number) => Promise<void> | void, window: number) => {
  const ready = new Map<number, Uint8Array>();
  let next = 0;
  let waiters: (() => void)[] = [];
  let chain = Promise.resolve();
  const flush = async () => {
    for (let frame = ready.get(next); frame; frame = ready.get(next)) {
      ready.delete(next);
      await write(frame, next);
      next++;
      const woken = waiters;
      waiters = [];
      for (const w of woken) w();
    }
  };
  return {
    async put(index: number, frame: Uint8Array) {
      while (index - next >= window) await new Promise<void>((r) => waiters.push(r));
      ready.set(index, frame);
      // Chained, so one flush runs at a time and a frame set while one ends is picked up by the next.
      chain = chain.then(flush);
      await chain;
    },
    get written() {
      return next;
    },
  };
};

/** Renders `options.projectDir` to `options.output`. Throws on a composition that can't render, naming why. */
export const render = async (options: RenderOptions): Promise<RenderResult> => {
  const { env, signal, onProgress } = options;
  const format = options.format ?? "mp4";
  const quality = options.quality ?? "standard";
  const fps = options.fps ?? 30;
  if (!(fps >= 1 && fps <= 240)) throw new Error(`fps must be between 1 and 240, got ${fps}.`);
  const projectDir = realpathSync(resolve(options.projectDir));
  const output = resolve(options.output);
  const work = mkdtempSync(join(tmpdir(), "verdandi-render-"));
  const timings: Record<RenderStage, number> = { open: 0, extract: 0, audio: 0, capture: 0, encode: 0 };
  let mark = performance.now();
  const lap = (stage: RenderStage) => {
    const now = performance.now();
    timings[stage] += now - mark;
    mark = now;
  };
  const server = await serveProject(projectDir, {
    render: { fps, ...(options.variables && { variables: options.variables }) },
    mounts: { frames: join(work, "frames") },
  });
  const browsers = [await launchBrowser(env)];
  try {
    const browser = browsers[0] as (typeof browsers)[number];
    onProgress?.({ stage: "open", done: 0, total: 1 });
    const page = await openComposition(browser, `${server.url}/${options.entry ?? "index.html"}`, { width: 1920, height: 1080 });
    const manifest = (await page.evaluate(() => window.__vd?.manifest())) as Manifest;
    await page.setViewport({ width: manifest.width, height: manifest.height, deviceScaleFactor: 1 });
    const { duration, width, height } = manifest;
    if (!(duration > 0))
      throw new Error("The composition has no length. Set data-duration on its root element, or register a timeline or media that ends.");
    const frames = Math.max(1, Math.ceil(duration * fps - 1e-6));
    lap("open");

    const sources = sourceResolver(server.url, projectDir, work);
    await sources.fetchRemote(manifest.media.map((m) => m.src));
    // Media stages report only when there is media, so a text-only render never says it decodes or mixes anything.
    if (manifest.media.some((m) => m.kind === "video")) onProgress?.({ stage: "extract", done: 0, total: manifest.media.length });
    const videos = new Map<string, ExtractedVideo>(
      (await extractVideos(env, manifest.media, sources.local, fps, join(work, "frames"), signal)).map((v) => [v.renderId, v]),
    );
    lap("extract");
    if (manifest.media.some((m) => m.audible)) onProgress?.({ stage: "audio", done: 0, total: 1 });
    const audioFile = join(work, "audio.wav");
    const hasAudio =
      format !== "gif" && format !== "png-sequence" && (await mixAudio(env, manifest.media, sources.local, duration, audioFile, signal));
    lap("audio");

    const alpha = hasAlpha(format);
    const sequence = format === "gif" || format === "png-sequence";
    const seqDir = join(work, "sequence");
    if (sequence) mkdirSync(seqDir, { recursive: true });
    mkdirSync(dirname(output), { recursive: true });
    const encoder = sequence
      ? undefined
      : Bun.spawn(
          [
            ffmpegPath(env),
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "image2pipe",
            "-framerate",
            String(fps),
            "-c:v",
            alpha ? "png" : "mjpeg",
            "-i",
            "-",
            ...(hasAudio ? ["-i", audioFile, "-map", "0:v", "-map", "1:a", ...audioArgs(format)] : []),
            ...videoArgs(format as "mp4" | "webm" | "mov", quality, options.crf),
            "-t",
            String(frames / fps),
            output,
          ],
          { env: { ...env }, stdin: "pipe", stdout: "ignore", stderr: "pipe", ...(signal && { signal }) },
        );
    const encoderLog = encoder ? new Response(encoder.stderr).text() : Promise.resolve("");

    // Workers past the first get their own Chrome, opened and sized like the first page.
    const count = Math.max(1, Math.min(options.workers ?? defaultWorkers(frames), frames));
    const url = `${server.url}/${options.entry ?? "index.html"}`;
    const extra = await Promise.all(
      Array.from({ length: count - 1 }, async () => {
        const b = await launchBrowser(env);
        browsers.push(b);
        const p = await openComposition(b, url, { width, height });
        return p;
      }),
    );
    const pages = [page, ...extra];
    const shotOptions =
      alpha || sequence
        ? ({ type: "png", omitBackground: alpha, clip: { x: 0, y: 0, width, height } } as const)
        : ({ type: "jpeg", quality: quality === "draft" ? 80 : 95, optimizeForSpeed: true, clip: { x: 0, y: 0, width, height } } as const);
    const writer = orderedWriter(async (shot, i) => {
      if (encoder) {
        encoder.stdin.write(shot);
        await encoder.stdin.flush();
      } else await Bun.write(join(seqDir, `frame_${String(i + 1).padStart(6, "0")}.png`), shot);
      onProgress?.({ stage: "capture", done: i + 1, total: frames });
    }, count * 4);
    // Interleaved (worker w takes frames w, w+n, …), so the writer never waits long for the frame it needs.
    await Promise.all(
      pages.map(async (p, w) => {
        for (let i = w; i < frames; i += pages.length) {
          signal?.throwIfAborted();
          await writer.put(i, await captureAt(p, i / fps, videos, server.url, shotOptions));
        }
      }),
    );
    lap("capture");

    onProgress?.({ stage: "encode", done: 0, total: 1 });
    if (encoder) {
      await encoder.stdin.end();
      const code = await encoder.exited;
      if (code !== 0)
        throw new Error(`ffmpeg could not encode the video (exit ${code}): ${(await encoderLog).trim().split("\n").slice(-5).join("\n")}`);
    } else if (format === "gif") {
      const args = gifArgs(fps, join(seqDir, "frame_%06d.png"), join(work, "palette.png"), output);
      await runFfmpeg(env, args.palette, signal);
      await runFfmpeg(env, args.encode, signal);
    } else {
      mkdirSync(output, { recursive: true });
      for (const f of readdirSync(seqDir)) copyFileSync(join(seqDir, f), join(output, f));
    }
    lap("encode");
    return { output, frames, duration, width, height, workers: count, timings };
  } finally {
    await Promise.all(browsers.map((b) => b.close().catch(() => undefined)));
    server.stop();
    rmSync(work, { recursive: true, force: true });
  }
};

/** One PNG of the composition at each of `times` (seconds), with video frames painted. Returns the files written. */
export const snapshot = async (options: {
  readonly projectDir: string;
  readonly entry?: string;
  readonly times: readonly number[];
  readonly outDir: string;
  readonly env: Env;
  readonly fps?: number;
}) => {
  const fps = options.fps ?? 30;
  const projectDir = realpathSync(resolve(options.projectDir));
  const work = mkdtempSync(join(tmpdir(), "verdandi-snapshot-"));
  const server = await serveProject(projectDir, { render: { fps }, mounts: { frames: join(work, "frames") } });
  const browser = await launchBrowser(options.env);
  try {
    const page = await openComposition(browser, `${server.url}/${options.entry ?? "index.html"}`, { width: 1920, height: 1080 });
    const manifest = (await page.evaluate(() => window.__vd?.manifest())) as Manifest;
    await page.setViewport({ width: manifest.width, height: manifest.height, deviceScaleFactor: 1 });
    const sources = sourceResolver(server.url, projectDir, work);
    await sources.fetchRemote(manifest.media.map((m) => m.src));
    const videos = new Map(
      (await extractVideos(options.env, manifest.media, sources.local, fps, join(work, "frames"))).map((v) => [v.renderId, v]),
    );
    mkdirSync(options.outDir, { recursive: true });
    const files: string[] = [];
    for (const [i, raw] of options.times.entries()) {
      const t = Math.min(Math.max(0, raw), manifest.duration);
      const shot = await captureAt(page, t, videos, server.url, {
        type: "png",
        clip: { x: 0, y: 0, width: manifest.width, height: manifest.height },
      });
      const file = join(options.outDir, `frame-${String(i + 1).padStart(2, "0")}-at-${t.toFixed(2)}s.png`);
      await Bun.write(file, shot);
      files.push(file);
    }
    return { files, manifest };
  } finally {
    await browser.close().catch(() => undefined);
    server.stop();
    rmSync(work, { recursive: true, force: true });
  }
};

/** The composition's resolved timeline (`Manifest`), read from the page: every clip and media window, and the length. */
export const inspect = async (options: { readonly projectDir: string; readonly entry?: string; readonly env: Env }) => {
  const server = await serveProject(realpathSync(resolve(options.projectDir)), { render: { fps: 30 } });
  const browser = await launchBrowser(options.env);
  try {
    const page = await openComposition(browser, `${server.url}/${options.entry ?? "index.html"}`, { width: 1920, height: 1080 });
    return (await page.evaluate(() => window.__vd?.manifest())) as Manifest;
  } finally {
    await browser.close().catch(() => undefined);
    server.stop();
  }
};
