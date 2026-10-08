import { expect, test } from "bun:test";
import { assetMarkup, insertIntoComposition, seconds, setAttribute } from "./patch.ts";

const source = `<div id="root" data-duration="5">
  <!-- <p id="title" data-start="9"> -->
  <h1 class="big"
      id="title" data-start="1" data-duration='2'>Hi</h1>
  <video id="v" src="a.mp4" muted data-hidden data-start="0" />
</div>`;

test("an edit changes only the one attribute, keeping the file's own formatting", () => {
  const out = setAttribute(source, "title", "data-start", "1.5");
  expect(out).toBe(source.replace(`data-start="1" data-duration='2'`, `data-start="1.5" data-duration='2'`));
});

test("commented-out markup is never the target", () => {
  expect(setAttribute(source, "title", "data-start", "3")).toContain(`<!-- <p id="title" data-start="9"> -->`);
});

test("attributes are added, written bare, removed, and an unknown id is undefined", () => {
  expect(setAttribute(source, "title", "data-hidden", "")).toContain(`data-duration='2' data-hidden>Hi`);
  expect(setAttribute(source, "v", "data-hidden", null)).toContain(`muted data-start="0" />`);
  expect(setAttribute(source, "v", "data-volume", "0.5")).toContain(`data-start="0" data-volume="0.5" />`);
  expect(setAttribute(source, "nope", "data-start", "1")).toBeUndefined();
});

test("seconds are written with at most three decimals", () => {
  expect(seconds(1.23456)).toBe("1.235");
  expect(seconds(2)).toBe("2");
});

test("an inserted asset becomes the composition's first child, with a free id and the right element", () => {
  const out = insertIntoComposition(source, "missing", "<p>x</p>");
  expect(out).toBeUndefined();
  const page = `<body>\n  <div id="root" data-composition-id="main" data-duration="5">\n    <h1 id="t">Hi</h1>\n  </div>\n</body>`;
  const { id, markup } = assetMarkup("assets/My Clip.mp4", 1.5, 2, new Set(["My-Clip"]));
  expect(id).toBe("My-Clip-2");
  expect(markup).toContain(`<video id="My-Clip-2" class="clip" src="assets/My Clip.mp4" muted data-start="1.5" data-track-index="2"`);
  expect(insertIntoComposition(page, "main", markup)).toBe(page.replace(`data-duration="5">`, `data-duration="5">\n    ${markup}`));
  expect(assetMarkup("assets/song.mp3", 0, 0, new Set()).markup).toStartWith(`<audio id="song"`);
  expect(assetMarkup("assets/1.png", 0, 0, new Set()).id).toBe("asset-1");
});

test("an insert into a CRLF file keeps CRLF", () => {
  const page = "<body>\r\n  <div id=\"root\" data-composition-id=\"main\">\r\n  </div>\r\n</body>";
  expect(insertIntoComposition(page, "main", "<p></p>")).toBe(page.replace('id="main">', 'id="main">\r\n    <p></p>'));
});
