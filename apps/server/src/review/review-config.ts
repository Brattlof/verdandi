import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";

/**
 * `review.yaml` in the Verdandi home (DESIGN §14.5): `enabled: true` reviews finished tasks in the background, off until
 * it's measured; `allowMetered: true` lets a review spend metered dollars, which it otherwise never does.
 */
const ReviewFile = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  allowMetered: Schema.optionalKey(Schema.Boolean),
});

export const reviewSettingsFile = (home: string) => join(home, "review.yaml");

/** Read once when verdandid starts, like `memory.yaml`. A broken file stops it, naming the file and key. */
export const loadReviewSettings = (home: string) => {
  const file = reviewSettingsFile(home);
  if (!existsSync(file)) return { enabled: false, allowMetered: false };
  try {
    const data = Schema.decodeUnknownSync(ReviewFile)(Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}, { onExcessProperty: "error" });
    return { enabled: data.enabled ?? false, allowMetered: data.allowMetered ?? false };
  } catch (e) {
    throw new Error(
      `${file}: ${e instanceof Error ? e.message : String(e)}\nFix the file (it takes enabled: true or false, and allowMetered: true or false), or delete it.`,
    );
  }
};
