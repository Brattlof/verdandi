import { afterEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, Result } from "effect";
import { projectIdFor } from "../event-store/decider.ts";
import { loadSpendCaps, spendCapsFile } from "./spend-caps.ts";

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) removeTempHome(h);
});
const homeWith = (yaml?: string) => {
  const home = makeTempHome();
  homes.push(home);
  if (yaml !== undefined) writeFileSync(spendCapsFile(home), yaml);
  return home;
};
const load = (home: string) => Effect.runSync(loadSpendCaps(home));

test("no file means no caps", () => {
  const caps = Result.getOrThrow(load(homeWith()));
  expect(caps.profile).toEqual({});
  expect(caps.projects.size).toBe(0);
});

test("a project's caps are found however its folder is written", () => {
  const caps = Result.getOrThrow(load(homeWith("monthly: 50\nprojects:\n  'C:\\Users\\a b\\repo': { daily: 2 }\n")));
  expect(caps.profile).toEqual({ month: 50 });
  expect(caps.projects.get(projectIdFor("c:/Users/a b/repo"))).toEqual({ day: 2 });
});

test("a project's caps are found through a symlink or a trailing slash, and a folder not made yet doesn't break the file", () => {
  const dir = homeWith(); // a temp folder; on macOS its path itself goes through the /var symlink
  mkdirSync(join(dir, "app"));
  const real = realpathSync.native(join(dir, "app"));
  symlinkSync(real, join(dir, "app link"), "junction");
  const projects = { [`${join(dir, "app link")}/`]: { daily: 2 }, [join(dir, "app link", "not yet")]: { monthly: 9 } };
  const caps = Result.getOrThrow(load(homeWith(JSON.stringify({ projects }))));
  expect(caps.projects.get(projectIdFor(real))).toEqual({ day: 2 });
});

test.each([
  ["dayly: 5\n", /\["dayly"\]/],
  ["daily: 0\n", /\["daily"\]/],
  ["projects:\n  /repo: { daily: -1 }\n", /\["projects"\]\["\/repo"\]\["daily"\]/],
])("a broken caps file fails loudly, naming the file and the key: %s", (yaml, key) => {
  const home = homeWith(yaml);
  const loaded = load(home);
  const failure = Result.isFailure(loaded) ? loaded.failure : "";
  expect(failure).toStartWith(`${spendCapsFile(home)}: `);
  expect(failure).toMatch(key);
});
