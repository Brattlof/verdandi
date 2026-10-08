import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gsapPath } from "../engine/bundle.ts";
import { checkProject } from "./check.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vd-contrast-"));
  mkdirSync(join(dir, "vendor"));
  copyFileSync(gsapPath(), join(dir, "vendor", "gsap.min.js"));
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head><script src="vendor/gsap.min.js"></script>
<style>body { background: #888 } p { margin: 0; font: 20px system-ui }</style></head><body>
<div id="root" data-composition-id="main" data-width="400" data-height="200" data-duration="3">
  <p id="faint" data-start="0" style="left: 10px; top: 10px; color: #777">Hard to read</p>
  <p id="covered" data-start="0" style="left: 200px; top: 10px; color: #333">Under the panel</p>
  <div id="panel" data-start="0" style="left: 190px; top: 0; width: 210px; height: 60px; background: #000"></div>
  <p id="clear" data-start="0" style="left: 10px; top: 100px; color: #000; background: #fff">Easy to read</p>
</div>
<script>const tl = gsap.timeline({ paused: true }); tl.to("#clear", { x: 100, duration: 3 }); window.__timelines.main = tl;</script></body></html>`,
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("text too close to its background fails WCAG AA, and readable text passes", async () => {
  const { findings } = await checkProject({ projectDir: dir, env: process.env, samples: 3 });
  const contrast = findings.filter((f) => f.code === "contrast_aa_failure");
  expect(contrast).toHaveLength(1);
  expect(contrast[0]).toMatchObject({ severity: "error" });
  expect(contrast[0]?.message).toContain("Hard to read");
}, 60_000);
