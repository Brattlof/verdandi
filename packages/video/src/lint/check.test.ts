import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gsapPath } from "../engine/bundle.ts";
import { checkProject } from "./check.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "vd-check-"));
  mkdirSync(join(dir, "vendor"));
  copyFileSync(gsapPath(), join(dir, "vendor", "gsap.min.js"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, body: string, script = "") =>
  writeFileSync(
    join(dir, name),
    `<!doctype html><html><head><script src="vendor/gsap.min.js"></script><style>#bg { width: 10px; height: 10px; background: url(missing.png) }</style></head><body>
<div id="root" data-composition-id="main" data-width="200" data-height="100" data-duration="4">${body}</div><script>${script}</script></body></html>`,
  );

test("the live pass reports what only a running page shows", async () => {
  write(
    "index.html",
    `<div id="bg" data-start="0"></div>
     <p id="wide" data-start="0" data-duration="5" style="left: 150px; top: 10px; white-space: nowrap">far too wide for the canvas</p>`,
    `const tl = gsap.timeline({ paused: true }); tl.set("#wide", { autoAlpha: 1 }, 0); window.__timelines.main = tl;`,
  );
  const result = await checkProject({ projectDir: dir, env: process.env, samples: 4 });
  expect(result.browserSkipped).toBe(false);
  expect(result.findings.map((f) => f.code).sort()).toEqual(
    ["clip_ends_past_root_duration", "gsap_animates_clip_element", "request_failed", "sweep_static", "text_outside_canvas"].sort(),
  );
}, 60_000);

test("lint errors skip the browser pass", async () => {
  write("index.html", `<video src="nope.mp4" data-start="0"></video>`);
  const result = await checkProject({ projectDir: dir, env: process.env });
  expect(result.browserSkipped).toBe(true);
  expect(result.ok).toBe(false);
});
