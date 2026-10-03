import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { contextEntry, type DecisionAnswer } from "@verdandi/contracts";
import { flagged } from "@verdandi/decisions";
import { Effect } from "effect";

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** How a context file is named to the user and in a trust list: relative to the thread's folder `cwd` when inside it. */
export const shownPath = (path: string, cwd: string) => {
  const rel = relative(cwd, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel.split("\\").join("/");
};

/** A flagged file a harness would load, as the scan saw it. */
export type ContextHit = { readonly file: string; readonly text: string; readonly answer: DecisionAnswer };

/**
 * The files among `paths` (a harness's `loads`) that the injection scan flags (DESIGN §17), named relative to `cwd`.
 * A file that can't be read is skipped: the harness can't load it either.
 */
export const flaggedFiles = (paths: readonly string[], cwd: string, scan: (text: string) => Effect.Effect<DecisionAnswer | undefined>) =>
  Effect.gen(function* () {
    const hits: ContextHit[] = [];
    for (const path of paths) {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const answer = yield* scan(text);
      if (answer && flagged(answer)) hits.push({ file: shownPath(path, cwd), text, answer });
    }
    return hits;
  });

/** The `context` trust list for `hits`: trusting it covers these files with these contents only. */
export const contextList = (hits: readonly ContextHit[]) => hits.map((h) => contextEntry(h.file, sha256(h.text)));
