import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Question } from "@verdandi/contracts";
import { editPlan, parseAnswer } from "./requests.ts";

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

test("editPlan returns the plan as the editor saved it, and says why when there is nothing to approve", async () => {
  const dir = mkdtempSync(join(tmpdir(), "verdandi-editor-"));
  try {
    // Each editor is a Bun script that does to the file what a user might.
    let n = 0;
    const editor = (body: string) => {
      const script = join(dir, `${++n}.ts`);
      writeFileSync(script, body);
      return `"${process.execPath}" "${script}"`;
    };
    const write = (text: string) => editor(`require("node:fs").writeFileSync(process.argv[2], ${JSON.stringify(text)})`);
    expect(await editPlan("1. Edit a", write("1. Edit b\r\n2. Test\r\n"))).toEqual({ plan: "1. Edit b\n2. Test" });
    expect(await editPlan("1. Edit a", editor(""))).toEqual({ error: expect.stringContaining("unchanged") });
    expect(await editPlan("1. Edit a", write(" \n"))).toEqual({ error: expect.stringContaining("empty") });
    expect(await editPlan("1. Edit a", editor("process.exit(3)"))).toEqual({ error: expect.stringContaining("exited with 3") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
