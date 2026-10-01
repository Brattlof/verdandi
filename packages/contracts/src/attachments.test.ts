import { expect, test } from "bun:test";
import { formatBytes } from "./attachments.ts";

test("a size that rounds up to the next unit is shown in that unit", () => {
  expect([1023, 1024, 1048063, 1048064, 1048575, 1048576, 5 * 1024 * 1024].map(formatBytes)).toEqual([
    "1023 B",
    "1 KB",
    "1023 KB",
    "1.0 MB",
    "1.0 MB",
    "1.0 MB",
    "5.0 MB",
  ]);
});
