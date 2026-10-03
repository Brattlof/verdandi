import { expect, test } from "bun:test";
import { diffLocks, type ReviewInput, review } from "./lockfile-diff.ts";

const lock = (packages: Record<string, string>) =>
  JSON.stringify({
    lockfileVersion: 1,
    packages: {
      "@verdandi/contracts": ["@verdandi/contracts@workspace:packages/contracts"],
      ...Object.fromEntries(Object.entries(packages).map(([key, spec]) => [key, [spec, "", {}, "sha512-x"]])),
    },
  });

const now = new Date("2026-10-03T00:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
const base = lock({ effect: "effect@4.0.0", ws: "ws@8.0.0" });
// A second version of a package sits under the key of the package that needs it.
const head = lock({ effect: "effect@4.0.0", ws: "ws@8.1.0", "react-devtools-core/ws": "ws@7.5.0", "@scope/pkg": "@scope/pkg@1.0.0" });
const input: ReviewInput = {
  changes: diffLocks(base, head),
  published: new Map([
    ["ws@8.1.0", daysAgo(3)],
    ["ws@7.5.0", daysAgo(400)],
    ["@scope/pkg@1.0.0", daysAgo(15)],
  ]),
  minimumAgeSeconds: 14 * 86_400,
  excludes: [],
  trustedBefore: [],
  trustedAfter: [],
  now,
};

test("the diff lists each package whose versions changed, leaving workspaces out", () => {
  expect(diffLocks(base, head)).toEqual([
    { name: "@scope/pkg", before: [], after: ["1.0.0"] },
    { name: "ws", before: ["8.0.0"], after: ["7.5.0", "8.1.0"] },
  ]);
  expect(diffLocks(base, base)).toEqual([]);
});

test("a version younger than the minimum fails until its package is excused in minimumReleaseAgeExcludes", () => {
  const { failures, summary } = review(input);
  expect(failures).toEqual([
    expect.stringMatching(/^ws@8\.1\.0 was published 3\.0 days ago, under the 14-day minimum\. Wait until 2026-10-14/),
  ]);
  expect(summary).toContain("| ws | 8.0.0 | 7.5.0, 8.1.0 |");
  expect(review({ ...input, excludes: ["ws"] }).failures).toEqual([]);
  expect(review({ ...input, published: new Map() }).failures).toHaveLength(3); // no publish time can't pass
});

test("a trustedDependencies change fails, naming what was added and removed", () => {
  const { failures } = review({ ...input, excludes: ["ws"], trustedBefore: ["esbuild"], trustedAfter: ["bun"] });
  expect(failures).toEqual([expect.stringContaining("(added bun, removed esbuild)")]);
});
