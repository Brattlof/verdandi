import { expect, test } from "bun:test";
import { contractsVersion } from "./index.ts";

test("exports a contracts version", () => {
  expect(typeof contractsVersion).toBe("string");
});
