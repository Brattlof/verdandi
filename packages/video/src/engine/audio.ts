/** The soundtrack: every audible media clip trimmed, timed, scaled and mixed into one AAC file, as long as the video. */
import type { MediaClip } from "../runtime/player.ts";
import type { Env } from "./browser.ts";
import { probe, runFfmpeg } from "./ffmpeg.ts";

/** atempo takes 0.5–2 per stage, so other rates are a chain of stages. */
export const atempo = (rate: number) => {
  const stages: string[] = [];
  let r = rate;
  while (r > 2) {
    stages.push("atempo=2");
    r /= 2;
  }
  while (r < 0.5) {
    stages.push("atempo=0.5");
    r /= 0.5;
  }
  if (Math.abs(r - 1) > 1e-6) stages.push(`atempo=${r.toFixed(6)}`);
  return stages;
};

/** One input's filter chain: tempo, gain, placed at its start, padded and cut to the composition's length. */
export const trackFilter = (i: number, clip: Pick<MediaClip, "start" | "rate" | "volume">, duration: number) => {
  const delay = Math.round(clip.start * 1000);
  return [
    `[${i}:a]aresample=48000`,
    "aformat=channel_layouts=stereo",
    ...atempo(clip.rate),
    `volume=${clip.volume}`,
    `adelay=${delay}|${delay}`,
    "apad",
    `atrim=0:${duration}`,
    `asetpts=N/SR/TB[a${i}]`,
  ].join(",");
};

/**
 * Mixes `clips` (resolved by `resolve` to local files) into `out`. Returns false when nothing is audible, so the
 * caller encodes a silent video. Mixing sums the tracks (no averaging), as an editor's timeline does.
 */
export const mixAudio = async (
  env: Env,
  clips: readonly MediaClip[],
  resolveSrc: (src: string) => string | undefined,
  duration: number,
  out: string,
  signal?: AbortSignal,
) => {
  const inputs: { file: string; clip: MediaClip }[] = [];
  for (const clip of clips) {
    if (!clip.audible || clip.hidden || clip.end <= clip.start || clip.volume <= 0) continue;
    const file = resolveSrc(clip.src);
    if (!file || !(await probe(env, file)).hasAudio) continue;
    inputs.push({ file, clip });
  }
  if (!inputs.length) return false;
  const args: string[] = [];
  for (const { file, clip } of inputs) {
    if (clip.loop) args.push("-stream_loop", "-1");
    args.push("-ss", String(clip.mediaStart), "-t", String((clip.end - clip.start) * clip.rate), "-i", file);
  }
  const graph = [
    ...inputs.map(({ clip }, i) => trackFilter(i, clip, duration)),
    `${inputs.map((_, i) => `[a${i}]`).join("")}amix=inputs=${inputs.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.89[out]`,
  ].join(";");
  await runFfmpeg(
    env,
    [...args, "-filter_complex", graph, "-map", "[out]", "-c:a", "pcm_s16le", "-ar", "48000", "-t", String(duration), out],
    signal,
  );
  return true;
};
