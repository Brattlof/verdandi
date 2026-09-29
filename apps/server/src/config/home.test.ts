import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { flag, resolveHome } from "./home.ts";

test("defaults to the default profile in ~/.goldiloop", () => {
  expect(resolveHome([])).toBe(join(homedir(), ".goldiloop", "profiles", "default"));
});

test("--home takes a folder, relative to the current directory", () => {
  expect(resolveHome(["chat", "--home", "./.goldiloop-dev"])).toBe(resolve(".goldiloop-dev"));
});

test("--home without a folder fails with the fix in the message", () => {
  expect(() => resolveHome(["--home"])).toThrow("--home needs a folder");
});

test("reads flag values and rejects a missing one", () => {
  expect(flag(["--model", "haiku"], "--model")).toBe("haiku");
  expect(flag([], "--model")).toBeUndefined();
  expect(() => flag(["--model", "--effort"], "--model")).toThrow("--model needs a value");
});
