// Reviews a bun.lock change against a base revision (DESIGN §17).
//   bun scripts/lockfile-diff.ts [base]   base defaults to origin/main; CI passes HEAD^1, the base side of a PR's merge commit
// Writes the added, removed and changed packages to the job summary ($GITHUB_STEP_SUMMARY, else stdout), and fails when
// an added version is younger than bunfig.toml's minimumReleaseAge and its package isn't in minimumReleaseAgeExcludes,
// or when package.json's trustedDependencies changed. Bun applies the age rule only when it resolves a version, so
// without this a hand-edited lockfile passes `bun install --frozen-lockfile` with a day-old package.
// The registry lookups are its only network calls; it never installs or runs a package.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

/** One package whose resolved versions differ between the two lockfiles. */
export type Change = { name: string; before: string[]; after: string[] };

/** Pure: the registry versions a bun.lock resolves, by package. Workspace, git and tarball entries are left out. */
const lockVersions = (text: string) => {
  const lock = Bun.JSONC.parse(text) as { packages?: Record<string, unknown[]> };
  const versions = new Map<string, Set<string>>();
  for (const [spec, registry] of Object.values(lock.packages ?? {})) {
    // A registry entry is ["name@version", "<registry or empty>", { … }, "<integrity>"].
    if (typeof spec !== "string" || typeof registry !== "string") continue;
    const at = spec.lastIndexOf("@");
    const name = spec.slice(0, at);
    versions.set(name, (versions.get(name) ?? new Set()).add(spec.slice(at + 1)));
  }
  return versions;
};

/** Pure: the packages whose versions differ between two bun.lock texts, by name. */
export const diffLocks = (base: string, head: string): Change[] => {
  const [before, after] = [lockVersions(base), lockVersions(head)];
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .map((name) => ({ name, before: [...(before.get(name) ?? [])].sort(), after: [...(after.get(name) ?? [])].sort() }))
    .filter((c) => c.before.join() !== c.after.join());
};

/** Pure: each version a change adds, as `name@version`. */
export const addedVersions = (changes: readonly Change[]) =>
  changes.flatMap((c) => c.after.filter((v) => !c.before.includes(v)).map((v) => `${c.name}@${v}`));

export type ReviewInput = {
  changes: readonly Change[];
  /** When each added `name@version` was published, from the registry; missing when it couldn't say. */
  published: ReadonlyMap<string, Date>;
  minimumAgeSeconds: number;
  excludes: readonly string[];
  trustedBefore: readonly string[];
  trustedAfter: readonly string[];
  now: Date;
};

/** Pure: the summary's lines and the failures, each naming its fix. */
export const review = (input: ReviewInput) => {
  const day = 86_400_000;
  const minimumDays = input.minimumAgeSeconds / 86_400;
  const failures: string[] = [];
  for (const spec of addedVersions(input.changes)) {
    const name = spec.slice(0, spec.lastIndexOf("@"));
    if (input.excludes.includes(name)) continue;
    const published = input.published.get(spec);
    if (!published) {
      failures.push(`${spec}: the registry gave no publish time, so its age can't be checked.`);
    } else if (input.now.getTime() - published.getTime() < input.minimumAgeSeconds * 1000) {
      const ready = new Date(published.getTime() + input.minimumAgeSeconds * 1000).toISOString().slice(0, 10);
      const age = ((input.now.getTime() - published.getTime()) / day).toFixed(1);
      failures.push(
        `${spec} was published ${age} days ago, under the ${minimumDays}-day minimum. Wait until ${ready}, or, for a security fix, add ${name} to minimumReleaseAgeExcludes in bunfig.toml with a dated comment (AGENTS.md).`,
      );
    }
  }
  const added = input.trustedAfter.filter((n) => !input.trustedBefore.includes(n));
  const removed = input.trustedBefore.filter((n) => !input.trustedAfter.includes(n));
  if (added.length + removed.length > 0) {
    failures.push(
      `trustedDependencies in package.json changed (${[...added.map((n) => `added ${n}`), ...removed.map((n) => `removed ${n}`)].join(", ")}): a maintainer reviews each added package's install scripts before merging.`,
    );
  }
  const versions = (vs: string[]) => vs.join(", ") || "—";
  const summary = [
    "| Package | Before | After |",
    "| --- | --- | --- |",
    ...input.changes.map((c) => `| ${c.name} | ${versions(c.before)} | ${versions(c.after)} |`),
  ];
  return { summary, failures };
};

const registryTime = async (spec: string) => {
  const at = spec.lastIndexOf("@");
  const res = await fetch(`https://registry.npmjs.org/${spec.slice(0, at).replace("/", "%2f")}`);
  if (!res.ok) throw new Error(`The npm registry answered ${res.status} for ${spec.slice(0, at)}; rerun the job.`);
  const time = ((await res.json()) as { time?: Record<string, string> }).time?.[spec.slice(at + 1)];
  return time ? new Date(time) : undefined;
};

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const base = process.argv[2] ?? "origin/main";
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: root });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim()}`);
    return r.stdout.toString();
  };
  if (Bun.spawnSync(["git", "diff", "--quiet", base, "--", "bun.lock", "package.json"], { cwd: root }).exitCode === 0) {
    console.log(`bun.lock and package.json are unchanged since ${base}.`);
    process.exit(0);
  }
  const bunfig = Bun.TOML.parse(await Bun.file(join(root, "bunfig.toml")).text()) as {
    install?: { minimumReleaseAge?: unknown; minimumReleaseAgeExcludes?: unknown };
  };
  const minimumAgeSeconds = bunfig.install?.minimumReleaseAge;
  if (typeof minimumAgeSeconds !== "number") throw new Error("bunfig.toml: install.minimumReleaseAge must be a number of seconds.");
  const excludes = bunfig.install?.minimumReleaseAgeExcludes ?? [];
  if (!Array.isArray(excludes)) throw new Error("bunfig.toml: install.minimumReleaseAgeExcludes must be a list of package names.");
  const trusted = (text: string) => ((JSON.parse(text) as { trustedDependencies?: string[] }).trustedDependencies ?? []).toSorted();

  const changes = diffLocks(git("show", `${base}:bun.lock`), await Bun.file(join(root, "bun.lock")).text());
  const added = addedVersions(changes);
  const published = new Map<string, Date>();
  for (const spec of added) {
    const time = await registryTime(spec);
    if (time) published.set(spec, time);
  }
  const { summary, failures } = review({
    changes,
    published,
    minimumAgeSeconds,
    excludes,
    trustedBefore: trusted(git("show", `${base}:package.json`)),
    trustedAfter: trusted(await Bun.file(join(root, "package.json")).text()),
    now: new Date(),
  });
  const report = [
    `### bun.lock against ${base}`,
    "",
    ...(changes.length > 0 ? summary : ["No package versions changed."]),
    "",
    ...failures.map((f) => `- ❌ ${f}`),
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  console.log(report);
  if (failures.length > 0) process.exit(1);
}
