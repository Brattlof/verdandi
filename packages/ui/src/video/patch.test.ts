import { expect, test } from "bun:test";
import { seconds, setAttribute } from "./patch.ts";

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
