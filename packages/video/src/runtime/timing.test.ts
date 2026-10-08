import { describe, expect, test } from "bun:test";
import { parseStart, quantize, snap, sourceTime, visibleAt } from "./timing.ts";

describe("parseStart", () => {
  test("reads seconds, references and shifted references", () => {
    expect(parseStart(" 1.5 ")).toEqual({ kind: "absolute", seconds: 1.5 });
    expect(parseStart("-2")).toEqual({ kind: "absolute", seconds: 0 });
    expect(parseStart("intro")).toEqual({ kind: "ref", id: "intro", offset: 0 });
    expect(parseStart("intro + 2")).toEqual({ kind: "ref", id: "intro", offset: 2 });
    expect(parseStart("scene-2.end-0.5")).toEqual({ kind: "ref", id: "scene-2.end", offset: -0.5 });
  });

  test("an empty or malformed value is not timed", () => {
    expect(parseStart("")).toBeUndefined();
    expect(parseStart(null)).toBeUndefined();
    expect(parseStart("intro * 2")).toBeUndefined();
  });
});

describe("visibleAt", () => {
  test("windows are half-open, except that a clip reaching the end owns the final frame", () => {
    expect(visibleAt(1, 1, 2, 10)).toBe(true);
    expect(visibleAt(2, 1, 2, 10)).toBe(false);
    expect(visibleAt(0.1 + 0.2, 0.3, 1, 10)).toBe(true);
    expect(visibleAt(10, 5, 10, 10)).toBe(true);
    expect(visibleAt(10, 5, 9, 10)).toBe(false);
  });
});

test("render seeks land on the frame grid and authored decimals snap onto it", () => {
  expect(quantize(1 / 3, 30)).toBeCloseTo(10 / 30);
  expect(quantize(0.0499, 30)).toBe(1 / 30);
  expect(snap(0.1 + 0.2, 30)).toBe(9 / 30);
  expect(snap(0.31, 30)).toBe(0.31);
});

test("media source time follows offset and rate, holds at the end, and wraps when looping", () => {
  expect(sourceTime(2, 1, 2, undefined, false)).toBe(5);
  expect(sourceTime(10, 0, 1, 4, false)).toBe(4);
  expect(sourceTime(5, 1, 1, 4, true)).toBe(3);
});
