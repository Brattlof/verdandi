import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shaderNames } from "../runtime/shaders.ts";
import { runFfmpeg } from "./ffmpeg.ts";
import { snapshot } from "./render.ts";

const env = process.env;
let dir: string;

// Two full-frame scenes, red under blue, with every shader in turn blending red into blue for one second each.
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vd-shaders-"));
  const transitions = shaderNames
    .map((name, i) => `<div data-transition="${name}" data-from="red" data-to="blue" data-start="${i}" data-duration="1"></div>`)
    .join("\n");
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><style>.scene { inset: 0; width: 320px; height: 180px }</style></head><body>
<div id="root" data-composition-id="main" data-width="320" data-height="180" data-duration="${shaderNames.length}">
  <div id="red" class="scene" data-start="0" style="background: #ff0000"></div>
  <div id="blue" class="scene" data-start="0" style="background: #0000ff"></div>
  ${transitions}
</div></body></html>`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const pixel = async (png: string, x: number, y: number) => {
  const raw = join(dir, "px.rgb");
  await runFfmpeg(env, ["-i", png, "-vf", `crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
  return [...new Uint8Array(await Bun.file(raw).arrayBuffer())];
};

test("every shader compiles and blends the outgoing scene into the incoming one", async () => {
  const times = shaderNames.map((_, i) => i + 0.5);
  const { files } = await snapshot({ projectDir: dir, times, outDir: join(dir, "shots"), env });
  expect(files).toHaveLength(shaderNames.length);
  // Halfway through the iris, the circle shows blue at the centre and red is still in the corner.
  const iris = files[shaderNames.indexOf("iris")] ?? "";
  const [, , centreBlue = 0] = await pixel(iris, 160, 90);
  const [cornerRed = 0] = await pixel(iris, 2, 2);
  expect(centreBlue).toBeGreaterThan(200);
  expect(cornerRed).toBeGreaterThan(200);
}, 120_000);
