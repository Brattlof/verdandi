/** Output formats and quality presets: the ffmpeg arguments that turn captured frames into a file. */

export const formats = ["mp4", "webm", "mov", "gif", "png-sequence"] as const;
export type Format = (typeof formats)[number];
export const qualities = ["draft", "standard", "high"] as const;
export type Quality = (typeof qualities)[number];

/** Formats that keep transparency: frames are captured as PNG with no page background. */
export const hasAlpha = (format: Format) => format === "webm" || format === "mov" || format === "png-sequence";

const x264 = { draft: ["ultrafast", "28"], standard: ["medium", "18"], high: ["slow", "15"] } as const;
const vp9 = { draft: "36", standard: "30", high: "24" } as const;

/** ffmpeg arguments for the video stream, after the inputs. `crf` overrides the preset's. */
export const videoArgs = (format: Exclude<Format, "gif" | "png-sequence">, quality: Quality, crf?: number): string[] => {
  if (format === "mov") return ["-c:v", "prores_ks", "-profile:v", "4444", "-vendor", "apl0", "-pix_fmt", "yuva444p10le"];
  if (format === "webm")
    return [
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuva420p",
      "-b:v",
      "0",
      "-crf",
      String(crf ?? vp9[quality]),
      "-row-mt",
      "1",
      "-deadline",
      quality === "draft" ? "realtime" : "good",
      "-cpu-used",
      "4",
      "-auto-alt-ref",
      "0",
    ];
  const [preset, presetCrf] = x264[quality];
  return [
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(crf ?? presetCrf),
    "-bf",
    "0",
    // Screenshots are full-range RGB; players expect limited-range BT.709 YUV with even dimensions.
    "-vf",
    "pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-color_range",
    "tv",
    "-movflags",
    "+faststart",
  ];
};

/** ffmpeg arguments for the audio stream of each container. */
export const audioArgs = (format: Format): string[] =>
  format === "webm" ? ["-c:a", "libopus", "-b:a", "128k"] : ["-c:a", "aac", "-b:a", "192k"];

/** Two-pass palette GIF from an image sequence: arguments for the palette pass and the encode pass. */
export const gifArgs = (fps: number, input: string, palette: string, out: string, loop = 0) => ({
  palette: ["-framerate", String(fps), "-i", input, "-vf", "palettegen=stats_mode=diff", palette],
  encode: ["-framerate", String(fps), "-i", input, "-i", palette, "-lavfi", "paletteuse=dither=sierra2_4a", "-loop", String(loop), out],
});
