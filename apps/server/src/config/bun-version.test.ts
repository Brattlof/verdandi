import { expect, test } from "bun:test";
import { requireBun } from "./bun-version.ts";

test("refuses Bun older than 1.4.2 and says how to fix it", () => {
  expect(() => requireBun("1.3.14")).toThrow("Goldiloop needs Bun 1.4.2 or newer (this is 1.3.14). Run `bun upgrade`.");
});

test("accepts Bun 1.4.2 and newer", () => {
  expect(() => requireBun("1.4.2")).not.toThrow();
  expect(() => requireBun("1.5.0")).not.toThrow();
});
