/**
 * The video skills shipped with Verdandi (`packages/video/skills/<name>/`), installed into a profile's skills folder so
 * every harness sees them. What was installed is recorded by digest (`.video-skills.json` in that folder), so a later
 * Verdandi updates or removes its own copies, while a copy the user edited since is kept unless `force`.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const skillsDir = join(import.meta.dir, "../../skills");

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

/** A folder's digest: every file's path (with forward slashes) and bytes, in order. */
export const skillDigest = (dir: string) => {
  const hash = createHash("sha256");
  for (const f of files(dir)
    .map((p) => relative(dir, p).replaceAll("\\", "/"))
    .sort()) {
    hash
      .update(f)
      .update("\0")
      .update(readFileSync(join(dir, f)))
      .update("\0");
  }
  return hash.digest("hex");
};

export const bundledSkills = () =>
  readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

const recordFile = (target: string) => join(target, ".video-skills.json");
const readRecord = (target: string): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(recordFile(target), "utf8"));
  } catch {
    return {};
  }
};

/** Whether `to` is Verdandi's copy: what it installed (or what it ships now), not something the user changed. */
const ours = (to: string, name: string, record: Record<string, string>) => {
  const current = skillDigest(to);
  return current === record[name] || current === skillDigest(join(skillsDir, name));
};

/**
 * Copies each bundled skill into `target` (a profile's `skills/` folder): new ones are added, unchanged ones are left,
 * Verdandi's older copies are updated, and copies the user edited are replaced only with `force` (else `kept`).
 */
export const installSkills = (target: string, options: { readonly force?: boolean } = {}) => {
  const added: string[] = [];
  const updated: string[] = [];
  const kept: string[] = [];
  const record = readRecord(target);
  for (const name of bundledSkills()) {
    const from = join(skillsDir, name);
    const to = join(target, name);
    const shipped = skillDigest(from);
    if (existsSync(to)) {
      if (skillDigest(to) === shipped) {
        record[name] = shipped;
        continue;
      }
      if (!options.force && !ours(to, name, record)) {
        kept.push(name);
        continue;
      }
    }
    (existsSync(to) ? updated : added).push(name);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    record[name] = shipped;
  }
  writeFileSync(recordFile(target), `${JSON.stringify(record, null, 2)}\n`);
  return { added, updated, kept };
};

/** Takes the bundled skills back out of `target`, keeping ones the user edited (reported as `kept`) unless `force`. */
export const removeSkills = (target: string, options: { readonly force?: boolean } = {}) => {
  const removed: string[] = [];
  const kept: string[] = [];
  const record = readRecord(target);
  for (const name of bundledSkills()) {
    const to = join(target, name);
    if (!existsSync(to)) continue;
    if (!options.force && !ours(to, name, record)) {
      kept.push(name);
      continue;
    }
    rmSync(to, { recursive: true, force: true });
    delete record[name];
    removed.push(name);
  }
  if (existsSync(recordFile(target))) writeFileSync(recordFile(target), `${JSON.stringify(record, null, 2)}\n`);
  return { removed, kept };
};
