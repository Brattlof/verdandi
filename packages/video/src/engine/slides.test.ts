import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "./render.ts";

const dir = mkdtempSync(join(tmpdir(), "vd-slides-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("slides are listed in time order, resting at data-hold or just before their end", async () => {
  writeFileSync(
    join(dir, "index.html"),
    `<!doctype html><html><head></head><body>
<div id="root" data-composition-id="main" data-width="320" data-height="180" data-duration="6">
  <div id="two" data-start="one" data-duration="3" data-slide="Second" data-hold="1"></div>
  <div id="one" data-start="0" data-duration="3" data-slide="First" data-notes="Say hello."></div>
</div></body></html>`,
  );
  const { slides } = await inspect({ projectDir: dir, env: process.env });
  expect(slides).toEqual([
    { id: "one", title: "First", start: 0, rest: 3 - 1 / 30, notes: "Say hello." },
    { id: "two", title: "Second", start: 3, rest: 4, notes: "" },
  ]);
}, 60_000);
