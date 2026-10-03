import { expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempHome } from "@verdandi/testkit";
import { cliThreadsFile, defaultFolder, loadTrustedFolders, workspaceDir, workspaceSettingsFile } from "./workspace.ts";

test("a folder outside any project gets the workspace, made a git repo so checkpoints work there", () => {
  const home = makeTempHome();
  const elsewhere = makeTempHome();
  expect(defaultFolder(home, elsewhere, [])).toBe(workspaceDir(home));
  expect(existsSync(join(workspaceDir(home), ".git"))).toBe(true);
});

test("a folder inside a git repo, or one the CLI has a thread for, is the project", () => {
  const home = makeTempHome();
  const repo = makeTempHome();
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, "src"));
  expect(defaultFolder(home, join(repo, "src"), [])).toBe(join(repo, "src"));
  const known = makeTempHome();
  writeFileSync(cliThreadsFile(home), JSON.stringify({ [known]: "t1" }));
  expect(defaultFolder(home, known, [])).toBe(known);
});

test("--here and --workspace pick the folder outright, and not both", () => {
  const home = makeTempHome();
  const repo = makeTempHome();
  mkdirSync(join(repo, ".git"));
  expect(defaultFolder(home, repo, ["--workspace"])).toBe(workspaceDir(home));
  const plain = makeTempHome();
  expect(defaultFolder(home, plain, ["--here"])).toBe(plain);
  expect(() => defaultFolder(home, plain, ["--here", "--workspace"])).toThrow("Pick one of --here and --workspace");
});

test("workspace.yaml's folders load as real paths; a broken one names the file, the key and the fix", () => {
  const home = makeTempHome();
  expect(loadTrustedFolders(home)).toEqual([]);
  const downloads = makeTempHome();
  writeFileSync(workspaceSettingsFile(home), `folders:\n  - ${JSON.stringify(downloads)}\n`);
  expect(loadTrustedFolders(home)).toEqual([realpathSync.native(downloads)]);
  writeFileSync(
    workspaceSettingsFile(home),
    `folders:\n  - ${JSON.stringify(downloads)}\n  - ${JSON.stringify(join(downloads, "gone"))}\n`,
  );
  expect(() => loadTrustedFolders(home)).toThrow(/workspace\.yaml: folders\[1\]: .*gone isn't a folder that exists\.\nFix the file/);
  writeFileSync(workspaceSettingsFile(home), "folders:\n  - relative/path\n");
  expect(() => loadTrustedFolders(home)).toThrow("folders[0]: relative/path isn't an absolute path.");
  writeFileSync(workspaceSettingsFile(home), "folder: []\n");
  expect(() => loadTrustedFolders(home)).toThrow("workspace.yaml");
});
