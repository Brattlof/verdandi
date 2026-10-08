import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  <p id="outside">outside</p>
</div>
<script>const tl = gsap.timeline({ paused: true }); tl.fromTo("#a", { opacity: 0 }, { opacity: 1, duration: 1, ease: "none" }); window.__timelines.main = tl;</script>
</body></html>`;

const card = `<template><div id="card-root" data-composition-id="card" data-composition-variables='[{"id":"title","type":"string","label":"Title","default":"One"}]'>
<style>p { color: rgb(0, 128, 0) } :root { background: rgb(1, 2, 3) }</style>
<p class="t"></p>
<script>
  document.querySelector(".t").textContent = __verdandi.getVariables().title;
  const tl = gsap.timeline({ paused: true });
  tl.to(".t", { x: 100, duration: 1, ease: "none" });
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
  copyFileSync(gsapPath(), join(dir, "gsap.min.js"));
  server = await serveProject(dir, { render: { fps: 30 } });
  browser = await launchBrowser(process.env, 320, 180);
  page = await openComposition(browser, `${server.url}/index.html`, { width: 320, height: 180 });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const at = (t: number) =>
  page.evaluate(async (time) => {
    await window.__vd?.seek(time);
    const style = (sel: string) => getComputedStyle(document.querySelector(sel) as Element);
    const hosts = [...document.querySelectorAll("[data-vd-composition-file]")];
    return {
      a: { visibility: style("#a").visibility, opacity: Number(style("#a").opacity) },
      b: style("#b").visibility,
      cards: hosts.map((h) => ({
        id: h.getAttribute("data-composition-id"),
        visibility: getComputedStyle(h).visibility,
        text: h.querySelector(".t")?.textContent,
        color: getComputedStyle(h.querySelector(".t") as Element).color,
        background: getComputedStyle(h).backgroundColor,
        x: new DOMMatrix(getComputedStyle(h.querySelector(".t") as Element).transform).m41,
      })),
      outsideColor: style("#outside").color,
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
  expect(second).toMatchObject({ visibility: "visible", color: "rgb(0, 128, 0)", background: "rgb(1, 2, 3)" });
  expect(second?.x).toBeCloseTo(50);
  expect(first?.visibility).toBe("hidden");
  expect(s.outsideColor).not.toBe("rgb(0, 128, 0)");
  expect((await at(2.5)).cards[0]?.x).toBeCloseTo(50);
});

test("the manifest reports the declared duration and every clip's resolved window", async () => {
  const manifest = await page.evaluate(() => window.__vd?.manifest());
  expect(manifest?.duration).toBe(4);
  expect(manifest?.clips.find((c) => c.id === "b")).toMatchObject({ start: 1.5, end: 2.5 });
  expect(manifest?.clips.filter((c) => c.kind === "composition").map((c) => c.compositionId)).toEqual(["card", "card__vd2"]);
});
