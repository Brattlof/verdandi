import { expect, test } from "bun:test";
import { orderedWriter } from "./render.ts";

test("frames reach the encoder in order, and a worker too far ahead waits for the writer", async () => {
  const written: number[] = [];
  const writer = orderedWriter((_frame, i) => {
    written.push(i);
  }, 2);
  const frame = new Uint8Array(1);
  let farAhead = false;
  const late = writer.put(3, frame).then(() => {
    farAhead = true;
  });
  await writer.put(1, frame);
  expect(written).toEqual([]);
  expect(farAhead).toBe(false);
  await writer.put(0, frame);
  expect(written).toEqual([0, 1]);
  await writer.put(2, frame);
  await late;
  expect(written).toEqual([0, 1, 2, 3]);
});
