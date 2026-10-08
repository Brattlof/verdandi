/**
 * The video skills shipped with Verdandi (`packages/video/skills/<name>/`), installed into a profile's skills folder so
 * every harness sees them. A skill whose installed copy was edited is kept unless `force`, so a user's changes survive
 * an update.
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

export const skillsDir = join(import.meta.dir, "../../skills");

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

/** Whether two folders hold the same files with the same bytes. */
const same = (a: string, b: string) => {
  const fa = files(a)
    .map((f) => relative(a, f))
    .sort();
  const fb = files(b)
    .map((f) => relative(b, f))
    .sort();
  return fa.length === fb.length && fa.every((f, i) => f === fb[i] && readFileSync(join(a, f)).equals(readFileSync(join(b, f))));
};

export const bundledSkills = () =>
  readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

/**
 * Copies each bundled skill into `target` (a profile's `skills/` folder): new ones are added, unchanged ones are left,
 * ones that differ are replaced only with `force` (reported as `kept` otherwise).
 */
export const installSkills = (target: string, options: { readonly force?: boolean } = {}) => {
  const added: string[] = [];
  const updated: string[] = [];
  const kept: string[] = [];
  for (const name of bundledSkills()) {
    const from = join(skillsDir, name);
    const to = join(target, name);
    if (existsSync(to) && same(from, to)) continue;
    if (existsSync(to) && !options.force) {
      kept.push(name);
      continue;
    }
    (existsSync(to) ? updated : added).push(name);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
  }
  return { added, updated, kept };
};
