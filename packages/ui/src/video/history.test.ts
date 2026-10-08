import { expect, test } from "bun:test";
import { emptyHistory, record, redoStep, undoStep } from "./history.ts";

const edit = (label: string) => ({ label, path: "index.html", before: `${label}-before`, after: `${label}-after` });

test("undo walks back, redo walks forward, and a new edit drops what could be redone", () => {
  let h = record(record(emptyHistory, edit("move")), edit("trim"));
  const first = undoStep(h);
  expect(first?.edit.label).toBe("trim");
  h = first?.next ?? h;
  expect(undoStep(h)?.edit.label).toBe("move");
  const again = redoStep(h);
  expect(again?.edit.label).toBe("trim");
  h = record(h, edit("hide"));
  expect(redoStep(h)).toBeUndefined();
  expect(h.undo.map((e) => e.label)).toEqual(["move", "hide"]);
});
