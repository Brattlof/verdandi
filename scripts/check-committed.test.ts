import { expect, test } from "bun:test";
import { checkFile } from "./check-committed.ts";

// Built from parts, as any fixture holding a key-shaped string must be.
const key = ["sk-ant", "api03", "x".repeat(30)].join("-");

test("a token-shaped key is flagged on its line, without printing it", () => {
  const findings = checkFile("src/fixture.ts", `const a = 1;\nconst key = "${key}";\n`);
  expect(findings).toEqual([{ path: "src/fixture.ts", line: 2, why: expect.stringContaining("sk- API key") }]);
  expect(JSON.stringify(findings)).not.toContain(key);
  expect(checkFile("src/clean.ts", 'const key = "sk-ant-" + "api03-…";\n')).toEqual([]);
});

test("a tracked file that must stay local is flagged, whatever it holds", () => {
  for (const path of [
    "home/server.json",
    "server.json",
    ".env",
    "apps/agent/.env.local",
    ".verdandi-dev/verdandi.db",
    "x/state.db-wal",
    ".plans/plan.md",
    "spikes/a.ts",
    "evals/compression/private/94aafb6a.jsonl",
  ]) {
    expect(checkFile(path, "{}")).toEqual([{ path, why: expect.stringContaining("git rm --cached") }]);
  }
  for (const path of [".env.example", "docs/server.md", "apps/agent/src/.verdandi/routing.yaml", "data.dbx"]) {
    expect(checkFile(path, "{}")).toEqual([]);
  }
});
