import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gsapPath } from "./bundle.ts";
import { probe, runFfmpeg } from "./ffmpeg.ts";
import { render, snapshot } from "./render.ts";

const env = process.env;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vd-render-"));
  copyFileSync(gsapPath(), join(dir, "gsap.min.js"));
  await runFfmpeg(env, ["-f", "lavfi", "-i", "color=c=0x0000ff:s=160x90:d=2:r=30", "-pix_fmt", "yuv420p", join(dir, "blue.mp4")]);
  await runFfmpeg(env, ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", join(dir, "tone.wav")]);
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><script src="gsap.min.js"></script>
<style>body { background: #000 } #box { width: 40px; height: 40px; background: #fff; left: 200px; top: 70px }</style></head><body>
<div id="root" data-composition-id="main" data-width="320" data-height="180" data-duration="2">
  <video id="clip" src="blue.mp4" muted data-start="1" data-duration="1" style="left: 0; top: 0; width: 160px; height: 180px; object-fit: fill"></video>
  <audio id="tone" src="tone.wav" data-start="0.5" data-duration="1"></audio>
  <div id="box" data-start="0"></div>
</div>
<script>const tl = gsap.timeline({ paused: true }); tl.fromTo("#box", { x: 0 }, { x: 60, duration: 2, ease: "none" }); window.__timelines.main = tl;</script>
</body></html>`,
  );
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The RGB of one pixel of a PNG, decoded in Chrome-free fashion through ffmpeg. */
const pixel = async (png: string, x: number, y: number) => {
  const raw = join(dir, "px.rgb");
  await runFfmpeg(env, ["-i", png, "-vf", `crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
  return [...new Uint8Array(await Bun.file(raw).arrayBuffer())];
};

test("a render is as long as the composition, at its size, with the mixed soundtrack", async () => {
  const output = join(dir, "out.mp4");
  const result = await render({ projectDir: dir, output, env, fps: 30, quality: "draft" });
  expect(result).toMatchObject({ frames: 60, width: 320, height: 180 });
  const info = await probe(env, output);
  expect(info.hasVideo && info.hasAudio).toBe(true);
  expect(info.duration).toBeCloseTo(2, 1);
}, 60_000);

test("video frames are painted over the video only inside its window", async () => {
  const { files } = await snapshot({ projectDir: dir, times: [0.5, 1.5], outDir: join(dir, "snaps"), env });
  const [before, during] = files;
  expect(await pixel(before ?? "", 80, 90)).toEqual([0, 0, 0]);
  const [r, g, b] = await pixel(during ?? "", 80, 90);
  expect(r).toBeLessThan(20);
  expect(g).toBeLessThan(20);
  expect(b).toBeGreaterThan(230);
}, 60_000);
