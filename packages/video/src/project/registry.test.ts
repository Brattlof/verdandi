import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "./init.ts";
import { addBlock, searchBlocks } from "./registry.ts";
import { bundledSkills, installSkills, removeSkills, skillDigest } from "./skills.ts";

const scratch = mkdtempSync(join(tmpdir(), "vd-registry-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("a block is copied into compositions/ and mounted with its values, and an edited copy is never overwritten unasked", () => {
  const dir = join(scratch, "film");
  initProject(dir);
  const { files, snippet } = addBlock(dir, "lower-third", { values: { name: "Grace" } });
  expect(files).toEqual([join(dir, "compositions", "lower-third.html")]);
  expect(snippet).toContain(`data-composition-src="compositions/lower-third.html"`);
  expect(snippet).toContain(`data-variable-values='{"name":"Grace"}'`);
  writeFileSync(files[0] ?? "", "mine");
  expect(() => addBlock(dir, "lower-third")).toThrow("--force");
  expect(readFileSync(files[0] ?? "", "utf8")).toBe("mine");
  addBlock(dir, "lower-third", { force: true });
  expect(readFileSync(files[0] ?? "", "utf8")).not.toBe("mine");
  expect(() => addBlock(dir, "lower-thrd")).toThrow("lower-third");
});

test("search needs every word and ranks name and tag hits first", () => {
  expect(searchBlocks("lower interview").map((b) => b.name)).toContain("lower-third");
  expect(searchBlocks("lower-third nonsense-word")).toEqual([]);
});

test("installing skills adds new ones, leaves unchanged ones, updates its own, and keeps edited ones unless forced", () => {
  const target = join(scratch, "skills");
  const names = bundledSkills();
  const first = names[0];
  if (!first) return;
  expect(installSkills(target).added).toEqual(names);
  expect(installSkills(target)).toEqual({ added: [], updated: [], kept: [] });
  const edited = join(target, first, "SKILL.md");
  writeFileSync(edited, "my notes");
  expect(installSkills(target).kept).toEqual([first]);
  expect(readFileSync(edited, "utf8")).toBe("my notes");
  expect(installSkills(target, { force: true }).updated).toEqual([first]);
  // An older copy Verdandi itself installed is updated without --force: its digest is on record.
  writeFileSync(edited, "an older version we shipped");
  const record = JSON.parse(readFileSync(join(target, ".video-skills.json"), "utf8"));
  record[first] = skillDigest(join(target, first));
  writeFileSync(join(target, ".video-skills.json"), JSON.stringify(record));
  expect(installSkills(target).updated).toEqual([first]);
  writeFileSync(edited, "edited again");
  expect(removeSkills(target)).toEqual({ removed: names.filter((n) => n !== first), kept: [first] });
  expect(removeSkills(target, { force: true }).removed).toEqual([first]);
});
