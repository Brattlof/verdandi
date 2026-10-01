import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, makeFakeHarness, makeTempHome, makeTempRepo, removeTempHome } from "@verdandi/testkit";
import { estimateBatch, loadEvalSet, parseBatchRoute, runBatch, summarize } from "./batch.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempHome(d);
});
const track = (d: string) => {
  dirs.push(d);
  return d;
};

/** Passes once `a.txt` has `lines` lines: the fake harness adds one per edit. */
const linesAtLeast = (lines: number) =>
  `"${process.execPath}" -e "const f = require('fs'); process.exit(f.existsSync('a.txt') && f.readFileSync('a.txt', 'utf8').trim().split('\\n').length >= ${lines} ? 0 : 1)"`;

/** Batch runs spawn git and verifier processes for every task, which takes seconds on Windows. */
const SLOW = 60_000;

/** A repository whose policy routes every task to the fake model at medium effort, and an eval set of three tasks on it. */
const evalSet = () => {
  const repo = track(makeTempRepo({ "README.md": "fixture\n" }));
  mkdirSync(join(repo, ".verdandi"));
  writeFileSync(
    join(repo, ".verdandi", "routing.yaml"),
    "minConfidence: 1\ntargets:\n  mid: { harness: fake, provider: fake, model: fake }\nfallback: { prefer: [mid], effort: medium }\n",
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "policy");
  const commit = git(repo, "rev-parse", "HEAD").trim();
  const file = join(repo, "evals.yaml");
  const task = (id: string, prompt: string, verify: string) => ({ id, repo: ".", commit, prompt, verify });
  writeFileSync(
    file,
    JSON.stringify({
      tasks: [
        task("one-edit", "edit a.txt", linesAtLeast(1)),
        task("no-edit", "hello", linesAtLeast(1)),
        // One edit isn't enough: only a run that escalates, and so edits again, passes.
        task("two-edits", "edit a.txt", linesAtLeast(2)),
      ],
    }),
  );
  return { repo, file };
};

test(
  "each task runs on each route in its own copy of the repository, graded by its verifier",
  async () => {
    const { repo, file } = evalSet();
    const home = track(makeTempHome());
    const { results, stopped } = await runBatch({
      tasks: loadEvalSet(file),
      routes: ["auto", "fake/fake/medium"],
      home,
      runHome: join(home, "batch", "run"),
      harnesses: { fake: makeFakeHarness() },
      approve: false,
      taskTimeoutMs: 60_000,
      keep: false,
    });
    expect(stopped).toBeUndefined();
    const outcome = Object.fromEntries(results.map((r) => [`${r.task} ${r.route}`, [r.passed, r.escalations]]));
    expect(outcome).toEqual({
      "one-edit auto": [true, 0],
      "one-edit fake/fake/medium": [true, 0],
      "no-edit auto": [false, 0],
      "no-edit fake/fake/medium": [false, 0],
      // The routed run escalates and fixes it; the pinned baseline doesn't escalate.
      "two-edits auto": [true, 1],
      "two-edits fake/fake/medium": [false, 0],
    });
    expect(results.find((r) => r.task === "one-edit")?.ran).toEqual({ harness: "fake", model: "fake", effort: "medium" });
    expect(summarize(results)).toMatchObject([
      { route: "auto", tasks: 3, passed: 2, escalations: 1 },
      { route: "fake/fake/medium", tasks: 3, passed: 1, escalations: 0 },
    ]);
    // The repository itself is untouched: every run worked in a copy.
    expect(existsSync(join(repo, "a.txt"))).toBe(false);
    expect(git(repo, "status", "--porcelain").trim()).toBe("?? evals.yaml");
  },
  SLOW,
);

test(
  "a reached spend cap stops the run with what it has",
  async () => {
    const { file } = evalSet();
    const home = track(makeTempHome());
    writeFileSync(join(home, "spend-caps.yaml"), "daily: 0.000001\n");
    // The fake harness's turns are on its subscription, which caps don't count; `overage` turns are metered.
    const tasks = loadEvalSet(file).map((t) => ({ ...t, prompt: "overage" }));
    const { results, stopped } = await runBatch({
      tasks,
      routes: ["fake/fake/medium"],
      home,
      runHome: join(home, "batch", "run"),
      harnesses: { fake: makeFakeHarness() },
      approve: false,
      taskTimeoutMs: 60_000,
      keep: false,
    });
    expect(results).toHaveLength(1);
    expect(stopped).toContain("daily cap of metered spend is reached");
  },
  SLOW,
);

test("a dry run estimates each task on each route without running anything", async () => {
  const { file } = evalSet();
  const rows = await estimateBatch(loadEvalSet(file), ["auto", "fake/fake-large/high"], { fake: true });
  expect(rows.map((r) => [r.task, r.route, r.ran?.model, r.ran?.effort])).toEqual([
    ["one-edit", "auto", "fake", "medium"],
    ["one-edit", "fake/fake-large/high", "fake-large", "high"],
    ["no-edit", "auto", "fake", "medium"],
    ["no-edit", "fake/fake-large/high", "fake-large", "high"],
    ["two-edits", "auto", "fake", "medium"],
    ["two-edits", "fake/fake-large/high", "fake-large", "high"],
  ]);
});

test("a bad eval set or route fails loudly, naming the problem", () => {
  const { repo } = evalSet();
  const file = join(repo, "bad.yaml");
  writeFileSync(file, "tasks:\n  - { id: x, repo: ., commit: abc, prompt: p, verify: v }\n");
  expect(() => loadEvalSet(file)).toThrow(/bad\.yaml: [\s\S]*\["commit"\]/);
  expect(() => parseBatchRoute("opus")).toThrow('--route takes auto, or harness/model/effort such as claude-code/opus/medium; not "opus".');
});
