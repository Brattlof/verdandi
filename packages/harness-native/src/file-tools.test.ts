import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempHome, removeTempHome } from "@verdandi/testkit";
import { access, fileTools, readLimits, runFileTool } from "./file-tools.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempHome(d);
});

/** A Verdandi home with a workspace thread's folder in it, and a `workspace.yaml` folder and a stranger's outside it. */
const layout = () => {
  const [home, extra, elsewhere] = [makeTempHome(), makeTempHome(), makeTempHome()];
  dirs.push(home, extra, elsewhere);
  const cwd = join(home, "workspace", "my project");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(home, "attachments"));
  const reach = { home, folders: [extra], readable: [join(home, "attachments")] };
  return { home, extra, elsewhere, cwd, reach };
};

const run = (name: string, args: Record<string, unknown>, cwd: string, reach: ReturnType<typeof layout>["reach"]) => {
  const tool = fileTools[name];
  if (!tool) throw new Error(`no file tool ${name}`);
  return runFileTool(tool, args, cwd, reach);
};

test("file tools go freely in the thread's folder and workspace.yaml's, read attachments, refuse the rest of the home, and ask elsewhere", () => {
  const { home, extra, elsewhere, cwd, reach } = layout();
  expect(access("src/a.ts", cwd, reach, true)).toEqual({ kind: "allow" });
  expect(access(join(extra, "notes.md"), cwd, reach, true)).toEqual({ kind: "allow" });
  expect(access(join(home, "attachments", "x.log"), cwd, reach, false)).toEqual({ kind: "allow" });
  for (const [path, write] of [
    [join(home, "attachments", "x.log"), true],
    [join(home, "server.json"), false],
    [join(home, "native-sessions", "s.jsonl"), false],
    ["../../verdandi.db", false],
  ] as const)
    expect(access(path, cwd, reach, write)).toMatchObject({ kind: "refuse", why: expect.stringContaining("Verdandi's home") });
  expect(access(join(elsewhere, "a.txt"), cwd, reach, true)).toEqual({
    kind: "ask",
    note: `${join(elsewhere, "a.txt")} is outside this thread's folder: Verdandi keeps no checkpoint of it, so this can't be undone.`,
  });
  // A folder whose name only starts like the thread's isn't inside it.
  expect(access(`${cwd}-old/a.txt`, cwd, reach, false)).toMatchObject({ kind: "refuse" });
});

test.if(process.platform === "win32")("on Windows a path in another case or with backslashes is the same path", () => {
  const { home, cwd, reach } = layout();
  expect(access(cwd.toUpperCase().replaceAll("\\", "/"), cwd, reach, true)).toEqual({ kind: "allow" });
  expect(access(join(home.toLowerCase(), "server.json"), cwd, reach, false)).toMatchObject({ kind: "refuse" });
});

test("read_file numbers lines, joins CRLF ones, and points to the rest of a long file", async () => {
  const { cwd, reach } = layout();
  writeFileSync(join(cwd, "crlf.txt"), "one\r\ntwo\r\n");
  expect(await run("read_file", { path: "crlf.txt" }, cwd, reach)).toEqual({ text: "1\tone\n2\ttwo" });
  writeFileSync(join(cwd, "long.txt"), Array.from({ length: readLimits.lines + 5 }, (_, i) => `l${i + 1}`).join("\n"));
  const first = await run("read_file", { path: "long.txt" }, cwd, reach);
  expect(first.text).toEndWith(`(Lines 1–${readLimits.lines} of ${readLimits.lines + 5}. Read on with offset ${readLimits.lines + 1}.)`);
  expect(await run("read_file", { path: "long.txt", offset: readLimits.lines + 4 }, cwd, reach)).toEqual({
    text: `${readLimits.lines + 4}\tl${readLimits.lines + 4}\n${readLimits.lines + 5}\tl${readLimits.lines + 5}`,
  });
  expect(await run("read_file", { path: "missing.txt" }, cwd, reach)).toMatchObject({ isError: true });
});

test("edit_file replaces exact text once, keeps a CRLF file CRLF, and refuses text that's missing or ambiguous", async () => {
  const { cwd, reach } = layout();
  const file = join(cwd, "a b.ts");
  writeFileSync(file, "const a = 1;\r\nconst b = 1;\r\n");
  expect(
    await run("edit_file", { path: "a b.ts", old_string: "const a = 1;\nconst b", new_string: "const a = 2;\nconst c" }, cwd, reach),
  ).toEqual({ text: `Edited ${file}.` });
  expect(readFileSync(file, "utf8")).toBe("const a = 2;\r\nconst c = 1;\r\n");
  expect(await run("edit_file", { path: "a b.ts", old_string: "= 1", new_string: "= 3" }, cwd, reach)).toEqual({ text: `Edited ${file}.` });
  expect(await run("edit_file", { path: "a b.ts", old_string: "nope", new_string: "x" }, cwd, reach)).toMatchObject({ isError: true });
  expect(await run("edit_file", { path: "a b.ts", old_string: "const", new_string: "let" }, cwd, reach)).toMatchObject({
    isError: true,
    text: expect.stringContaining("2 times"),
  });
  expect(await run("edit_file", { path: "a b.ts", old_string: "const", new_string: "let", replace_all: true }, cwd, reach)).toEqual({
    text: `Edited ${file} (2 places).`,
  });
  expect(readFileSync(file, "utf8")).toBe("let a = 2;\r\nlet c = 3;\r\n");
});

test("write_file creates folders, and keeps an existing CRLF file's line endings", async () => {
  const { cwd, reach } = layout();
  expect(await run("write_file", { path: "new/dir/x.txt", content: "a\nb\n" }, cwd, reach)).toEqual({
    text: `Created ${join(cwd, "new", "dir", "x.txt")}.`,
  });
  expect(readFileSync(join(cwd, "new", "dir", "x.txt"), "utf8")).toBe("a\nb\n");
  writeFileSync(join(cwd, "w.txt"), "old\r\n");
  await run("write_file", { path: "w.txt", content: "x\ny\n" }, cwd, reach);
  expect(readFileSync(join(cwd, "w.txt"), "utf8")).toBe("x\r\ny\r\n");
});

test("glob and grep search the folder, skipping node_modules, .git and the refused home", async () => {
  const { home, cwd, reach } = layout();
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(cwd, "src", "a.ts"), "export const answer = 42;\n");
  writeFileSync(join(cwd, "node_modules", "dep", "b.ts"), "export const answer = 0;\n");
  writeFileSync(join(home, "server.json"), '{"token":"answer"}');
  expect(await run("glob", { pattern: "**/*.ts" }, cwd, reach)).toEqual({ text: "src/a.ts" });
  expect(await run("grep", { pattern: "answer = \\d+" }, cwd, reach)).toEqual({ text: "src/a.ts:1: export const answer = 42;" });
  // Searching the home itself finds the thread's folder in it, never the home's own files.
  expect((await run("grep", { pattern: "answer", path: home }, cwd, reach)).text).toBe("src/a.ts:1: export const answer = 42;");
  expect(await run("grep", { pattern: "(" }, cwd, reach)).toMatchObject({ isError: true });
});
