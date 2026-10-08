/** ffmpeg and ffprobe: found on PATH (or `VERDANDI_FFMPEG` / `VERDANDI_FFPROBE`), always run with the caller's env. */
import type { Env } from "./browser.ts";

const find = (env: Env, name: "ffmpeg" | "ffprobe") => {
  const override = name === "ffmpeg" ? env.VERDANDI_FFMPEG : env.VERDANDI_FFPROBE;
  const path = override ?? Bun.which(name, { PATH: env.PATH ?? "" });
  if (!path)
    throw new Error(
      `${name} not found on PATH. Install FFmpeg (macOS: brew install ffmpeg; Windows: winget install ffmpeg; Linux: your package manager), or set ${name === "ffmpeg" ? "VERDANDI_FFMPEG" : "VERDANDI_FFPROBE"}.`,
    );
  return path;
};

export const ffmpegPath = (env: Env) => find(env, "ffmpeg");

/** Runs ffmpeg to completion; a failure names the command's last lines of output. */
export const runFfmpeg = async (env: Env, args: readonly string[], signal?: AbortSignal) => {
  const proc = Bun.spawn([ffmpegPath(env), "-hide_banner", "-loglevel", "error", "-y", ...args], {
    env: { ...env },
    stdout: "ignore",
    stderr: "pipe",
    ...(signal && { signal }),
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`ffmpeg failed (exit ${code}): ${stderr.trim().split("\n").slice(-5).join("\n") || "no output"}`);
};

export type Probe = {
  readonly duration: number | undefined;
  readonly hasAudio: boolean;
  readonly hasVideo: boolean;
  readonly alpha: boolean;
  readonly codec: string | undefined;
};

/** What a media file holds; a file ffprobe can't read is an error naming it. */
export const probe = async (env: Env, file: string): Promise<Probe> => {
  const proc = Bun.spawn(
    [find(env, "ffprobe"), "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,pix_fmt", "-of", "json", file],
    {
      env: { ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`ffprobe could not read ${file}: ${err.trim() || `exit ${code}`}`);
  const json = JSON.parse(out) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; codec_name?: string; pix_fmt?: string }[];
  };
  const streams = json.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const duration = Number(json.format?.duration);
  return {
    duration: Number.isFinite(duration) ? duration : undefined,
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    hasVideo: !!video,
    alpha: /^(?:yuva|rgba|argb|bgra|abgr|gbrap|ya)/.test(video?.pix_fmt ?? ""),
    codec: video?.codec_name,
  };
};
