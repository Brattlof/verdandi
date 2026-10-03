import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { makeTempHome } from "@verdandi/testkit";
import { flag, flags, readServerFile, resolveHome, runningServer, serverFile } from "./home.ts";

test("a server.json whose process is gone counts as no server, and the error names both ways to run one", () => {
  const home = makeTempHome();
  writeFileSync(serverFile(home), JSON.stringify({ port: 1, token: "t", pid: 2147483646 }));
  expect(runningServer(home)).toBeUndefined();
  expect(() => readServerFile(home)).toThrow("Run `verdandi`, which runs it while you chat, or `verdandi start`");
  writeFileSync(serverFile(home), JSON.stringify({ port: 1, token: "t", pid: process.pid }));
  expect(runningServer(home)?.port).toBe(1);
});

test("defaults to the default profile in ~/.verdandi", () => {
  expect(resolveHome([])).toBe(join(homedir(), ".verdandi", "profiles", "default"));
});

test("--home takes a folder, relative to the current directory", () => {
  expect(resolveHome(["chat", "--home", "./.verdandi-dev"])).toBe(resolve(".verdandi-dev"));
});

test("--home without a folder fails with the fix in the message", () => {
  expect(() => resolveHome(["--home"])).toThrow("--home needs a folder");
});

test("reads flag values and rejects a missing one", () => {
  expect(flag(["--model", "haiku"], "--model")).toBe("haiku");
  expect(flag([], "--model")).toBeUndefined();
  expect(() => flag(["--model", "--effort"], "--model")).toThrow("--model needs a value");
});

test("takes --flag=value too: everything after the first =, never a longer flag with the same start", () => {
  expect(resolveHome(["start", "--home=./dev=home"])).toBe(resolve("dev=home"));
  expect(() => resolveHome(["--home="])).toThrow("--home needs a folder");
  expect(flag(["--models=x", "--model=opus"], "--model")).toBe("opus");
  expect(flag(["--models", "x"], "--model")).toBeUndefined();
  expect(flags(["--route=auto", "--route", "fake/fake/low", "--routes=x"], "--route")).toEqual(["auto", "fake/fake/low"]);
  expect(() => flags(["--route=auto", "--route="], "--route")).toThrow("--route needs a value");
});
