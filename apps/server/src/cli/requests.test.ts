import { describe, expect, test } from "bun:test";
import type { Question } from "@verdandi/contracts";
import { parseAnswer } from "./requests.ts";

const q = (multiSelect: boolean): Question => ({
  question: "Which?",
  header: "Pick",
  options: [
    { label: "Red", description: "warm" },
    { label: "Blue", description: "cool" },
  ],
  multiSelect,
});

describe("parseAnswer", () => {
  test("option numbers become labels", () => {
    expect(parseAnswer(q(false), " 2 ")).toBe("Blue");
    expect(parseAnswer(q(true), "1, 2")).toBe("Red, Blue");
  });

  test("anything else is a typed answer", () => {
    expect(parseAnswer(q(false), "2 shades of green")).toBe("2 shades of green");
  });

  test("rejects empty lines, unknown numbers and several picks on a single-select question", () => {
    expect(parseAnswer(q(false), "  ")).toBeUndefined();
    expect(parseAnswer(q(false), "3")).toBeUndefined();
    expect(parseAnswer(q(false), "1,2")).toBeUndefined();
  });
});
