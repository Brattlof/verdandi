import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../project/init.ts";
import { lintProject } from "./lint.ts";

const dirs: string[] = [];
const project = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "vd-lint-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("a new project lints clean", async () => {
  const dir = join(project({}), "fresh");
  initProject(dir);
  expect((await lintProject(dir)).findings).toEqual([]);
});

test("broken compositions get one finding per broken rule, on the right line", async () => {
  const dir = project({
    "index.html": `<!doctype html><html><head><style>.a { transition: opacity 0.3s }</style></head><body>
<div id="root" data-composition-id="main" data-duration="4">
  <div id="wrap" data-start="1" data-duration="2"><video src="missing.mp4" data-start="0" /></div>
  <audio src="data:audio/wav;base64,AAAA" data-start="x * 2"></audio>
  <div data-composition-src="compositions/nope.html" data-start="0"></div>
  <!-- <video src="commented-out.mp4"> -->
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.to("#wrap", { x: Math.random() * 10, repeat: -1 });
  window.__timelines["other"] = tl;
</script>
</body></html>`,
  });
  const { findings, ok } = await lintProject(dir);
  expect(ok).toBe(false);
  const got = findings.map((f) => `${f.code}@${f.line ?? "-"}`).sort();
  expect(got).toEqual(
    [
      "root_missing_dimensions@2",
      "self_closing_media_tag@3",
      "media_missing_id@3",
      "missing_local_asset@3",
      "video_missing_muted@3",
      "video_nested_in_timed_element@3",
      "media_missing_id@4",
      "base64_media_prohibited@4",
      "invalid_timing@4",
      "host_missing_composition_id@5",
      "missing_sub_composition@5",
      "missing_gsap_script@-",
      "non_deterministic_code@10",
      "timeline_id_mismatch@11",
      "gsap_infinite_repeat@8",
      "css_transition_used@1",
    ].sort(),
  );
});

test("sub-compositions are linted too, and inherit gsap from the page", async () => {
  const dir = project({
    "index.html": `<!doctype html><html><head><script src="g.js"></script></head><body><div id="root" data-composition-id="main" data-width="10" data-height="10"></div></body></html>`,
    "g.js": "",
    "compositions/card.html": `<template><div data-composition-id="card"><script>const tl = gsap.timeline({ paused: true });</script></div></template>`,
  });
  const { findings } = await lintProject(dir);
  expect(findings.map((f) => `${f.file}:${f.code}`)).toEqual(["compositions/card.html:gsap_timeline_not_registered"]);
});

test("references, timeline methods, module scripts and absolute paths are judged like the runtime does", async () => {
  const dir = project({
    "index.html": `<!doctype html><html><head><script src="gsap.js"></script></head><body>
<div id="root" data-composition-id="main" data-width="10" data-height="10">
  <div id="a" data-start="scene + 1" data-duration="1"></div>
  <div id="b" data-start="nowhere + 1" data-duration="1"></div>
  <div id="scene" data-composition-id="scene" data-composition-src="compositions/scene.html" data-start="0" data-duration="2"></div>
  <img id="logo" src="/assets/logo.png">
</div>
<script>const intro = gsap.timeline({ paused: true }); intro.pause(); document.querySelector("#a"); window.__timelines.main = intro;</script>
</body></html>`,
    "gsap.js": "",
    "assets/logo.png": "",
    "compositions/scene.html": `<template><div data-composition-id="scene"><script type="module">import "x";</script></div></template>`,
  });
  const codes = (await lintProject(dir)).findings.map((f) => `${f.file}:${f.code}`).sort();
  expect(codes).toEqual(
    [
      "compositions/scene.html:module_script_in_sub_composition",
      "index.html:absolute_project_path",
      "index.html:unknown_start_reference",
    ].sort(),
  );
});
