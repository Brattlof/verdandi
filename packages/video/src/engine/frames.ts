/**
 * Video pixels never come from Chrome's decoder (seeking a `<video>` is neither exact nor fast). ffmpeg decodes each
 * clip's source range up front, one image per output frame, and the page paints them over the `<video>` elements.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MediaClip } from "../runtime/player.ts";
import type { Env } from "./browser.ts";
import { probe, runFfmpeg } from "./ffmpeg.ts";

/** One video's decoded frames: `frame_000001.<ext>` onward, sampled every `step` source seconds from `from`. */
export type ExtractedVideo = {
  readonly renderId: string;
  readonly dir: string;
  readonly ext: "jpg" | "png";
  readonly from: number;
  readonly step: number;
  readonly count: number;
};

/** The file (1-based, as ffmpeg numbers them) showing source time `t`, clamped to the frames that exist. */
export const frameFile = (v: ExtractedVideo, t: number) => {
  const index = Math.min(v.count - 1, Math.max(0, Math.floor((t - v.from) / v.step + 1e-6)));
  return `frame_${String(index + 1).padStart(6, "0")}.${v.ext}`;
};

/** Decodes every visible video clip's frames into `root/<renderId>/`. */
export const extractVideos = async (
  env: Env,
  clips: readonly MediaClip[],
  resolveSrc: (src: string) => string | undefined,
  fps: number,
  root: string,
  signal?: AbortSignal,
): Promise<ExtractedVideo[]> => {
  const out: ExtractedVideo[] = [];
  for (const clip of clips) {
    if (clip.kind !== "video" || clip.hidden || clip.end <= clip.start) continue;
    const file = resolveSrc(clip.src);
    if (!file) throw new Error(`Video ${clip.renderId} has a source the renderer can't read: ${clip.src}`);
    const info = await probe(env, file);
    const length = info.duration ?? Number.POSITIVE_INFINITY;
    // Looping clips need the whole source once; others only the stretch they play.
    const span = clip.loop ? length - clip.mediaStart : Math.min((clip.end - clip.start) * clip.rate, length - clip.mediaStart);
    if (!(span > 0)) throw new Error(`Video ${clip.renderId} starts at ${clip.mediaStart}s, past the end of ${file} (${length}s).`);
    const ext = info.alpha ? "png" : "jpg";
    const dir = join(root, clip.renderId);
    mkdirSync(dir, { recursive: true });
    const sampling = fps / clip.rate;
    await runFfmpeg(
      env,
      [
        "-ss",
        String(clip.mediaStart),
        ...(info.alpha && info.codec === "vp9" ? ["-c:v", "libvpx-vp9"] : []),
        "-i",
        file,
        "-t",
        String(span),
        "-an",
        "-vf",
        `fps=${sampling}:start_time=0:round=down`,
        ...(ext === "jpg" ? ["-q:v", "2"] : ["-compression_level", "1"]),
        join(dir, `frame_%06d.${ext}`),
      ],
      signal,
    );
    const count = [...new Bun.Glob(`frame_*.${ext}`).scanSync(dir)].length;
    if (!count) throw new Error(`ffmpeg decoded no frames from ${file}.`);
    out.push({ renderId: clip.renderId, dir, ext, from: clip.mediaStart, step: 1 / sampling, count });
  }
  return out;
};
