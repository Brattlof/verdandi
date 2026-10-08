import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "puppeteer-core";
import { launchBrowser, openComposition } from "../engine/browser.ts";
import { gsapPath } from "../engine/bundle.ts";
import { serveProject } from "../engine/server.ts";

const index = `<!doctype html><html><head><script src="gsap.min.js"></script>
<style>.box{width:100px;height:100px;background:red}</style></head><body>
<div id="root" data-composition-id="main" data-width="320" data-height="180" data-duration="4">
  <div id="a" class="clip box" data-start="0" data-duration="1"></div>
  <div id="b" class="clip box" data-start="a + 0.5" data-duration="1"></div>
  <div id="card" data-composition-id="card" data-composition-src="card.html" data-start="2" data-duration="2"></div>
  <div id="card2" data-composition-id="card" data-composition-src="card.html" data-start="1" data-duration="1" data-variable-values='{"title":"Two"}'></div>
  <p id="outside" class="t v">outside</p>
</div>
<script>const tl = gsap.timeline({ paused: true }); tl.fromTo("#a", { opacity: 0 }, { opacity: 1, duration: 1, ease: "none" }); window.__timelines.main = tl;</script>
</body></html>`;

const card = `<template><div id="card-root" data-composition-id="card" data-composition-variables='[{"id":"title","type":"string","label":"Title","default":"One"}]'>
<style>p { color: rgb(0, 128, 0) } :root { background: rgb(1, 2, 3) }</style>
<p class="t"></p><b class="v" data-var-text="title">placeholder</b>
<div class="nested" data-composition-id="badge" data-composition-src="parts/badge.html" data-start="0" data-duration="1"></div>
<script>
  document.querySelector(".t").textContent = __verdandi.getVariables().title;
  const tl = gsap.timeline({ paused: true });
  tl.to(".t", { x: 100, duration: 1, ease: "none" });
  gsap.set("#card-root", { attr: { "data-hit": "yes" } });
  // Arrays of selectors and gsap.utils.toArray stay inside this mount too.
  gsap.set([".t", ".v"], { attr: { "data-arr": "1" } });
  for (const el of gsap.utils.toArray(".v")) el.setAttribute("data-util", "1");
  window.__timelines.card = tl;
</script>
</div></template>`;

let dir: string;
let server: Awaited<ReturnType<typeof serveProject>>;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vd-runtime-"));
  writeFileSync(join(dir, "index.html"), index);
  writeFileSync(join(dir, "card.html"), card);
  mkdirSync(join(dir, "parts"));
  // Named relative to card.html, the file that mounts it, not to the page.
  writeFileSync(
    join(dir, "parts", "badge.html"),
    `<template><div data-composition-id="badge" data-composition-variables='[{"id":"pic","type":"image","label":"Picture","default":"b.png"}]'><i class="badge">ok</i><img class="pic" data-var-src="pic"></div></template>`,
  );
  copyFileSync(gsapPath(), join(dir, "gsap.min.js"));
  server = await serveProject(dir, { render: { fps: 30 } });
  browser = await launchBrowser(process.env, 320, 180);
  page = await openComposition(browser, `${server.url}/index.html`, { width: 320, height: 180 });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.stop();
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

const at = (t: number) =>
  page.evaluate(async (time) => {
    await window.__vd?.seek(time);
    const style = (sel: string) => getComputedStyle(document.querySelector(sel) as Element);
    const hosts = [...document.querySelectorAll('[data-vd-composition-file="card.html"]')];
    return {
      a: { visibility: style("#a").visibility, opacity: Number(style("#a").opacity) },
      b: style("#b").visibility,
      cards: hosts.map((h) => ({
        id: h.getAttribute("data-composition-id"),
        visibility: getComputedStyle(h).visibility,
        text: h.querySelector(".t")?.textContent,
        bound: h.querySelector(".v")?.textContent,
        nested: h.querySelector(".badge")?.textContent,
        rootHit: h.querySelector("[data-vd-authored-id]")?.getAttribute("data-hit"),
        pic: h.querySelector<HTMLImageElement>(".pic")?.getAttribute("src"),
        cssVar: getComputedStyle(h).getPropertyValue("--title"),
        color: getComputedStyle(h.querySelector(".t") as Element).color,
        background: getComputedStyle(h).backgroundColor,
        x: new DOMMatrix(getComputedStyle(h.querySelector(".t") as Element).transform).m41,
      })),
      outsideColor: style("#outside").color,
      outsideTouched: ["data-arr", "data-util"].some((a) => document.getElementById("outside")?.hasAttribute(a)),
      leaked: document.querySelectorAll("[data-util]").length,
    };
  }, t);

test("clips show only inside their windows, and a reference start follows the clip it names", async () => {
  const early = await at(0.5);
  expect(early.a).toEqual({ visibility: "visible", opacity: 0.5 });
  expect(early.b).toBe("hidden");
  const later = await at(1.6);
  expect(later.a.visibility).toBe("hidden");
  expect(later.b).toBe("visible");
});

test("each mount of a sub-composition gets its own id, variables, scoped styles and timeline", async () => {
  const s = await at(1.5);
  const [first, second] = s.cards;
  expect(first?.id).toBe("card");
  expect(second?.id).toBe("card__vd2");
  expect([first?.text, second?.text]).toEqual(["One", "Two"]);
  expect([first?.bound, second?.bound, second?.cssVar]).toEqual(["One", "Two", "Two"]);
  expect([first?.nested, second?.nested]).toEqual(["ok", "ok"]);
  // The file's own root, by the id it was written with, in each mount.
  expect([first?.rootHit, second?.rootHit]).toEqual(["yes", "yes"]);
  // A variable's path is relative to the file that declares it, like an authored src.
  expect(first?.pic).toEndWith("/parts/b.png");
  expect(second).toMatchObject({ visibility: "visible", color: "rgb(0, 128, 0)", background: "rgb(1, 2, 3)" });
  expect(second?.x).toBeCloseTo(50);
  expect(first?.visibility).toBe("hidden");
  expect(s.outsideColor).not.toBe("rgb(0, 128, 0)");
  // Each mount's script touched only its own .t and .v: two mounts, one .v each.
  expect(s.outsideTouched).toBe(false);
  expect(s.leaked).toBe(2);
  expect((await at(2.5)).cards[0]?.x).toBeCloseTo(50);
});

test("the manifest reports the declared duration and every clip's resolved window", async () => {
  const manifest = await page.evaluate(() => window.__vd?.manifest());
  expect(manifest?.duration).toBe(4);
  expect(manifest?.clips.find((c) => c.id === "b")).toMatchObject({ start: 1.5, end: 2.5 });
  expect(manifest?.clips.filter((c) => c.kind === "composition").map((c) => c.compositionId)).toEqual([
    "card",
    "badge",
    "card__vd2",
    "badge__vd2",
  ]);
});
