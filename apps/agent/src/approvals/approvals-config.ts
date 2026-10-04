import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";

/**
 * `approvals.yaml` in the Verdandi home (DESIGN §17): `smart: true` turns on smart approvals of the native harness's
 * terminal commands, off until the user chooses them (§23's question 3 stays open).
 */
const ApprovalsFile = Schema.Struct({ smart: Schema.optionalKey(Schema.Boolean) });

export const approvalsSettingsFile = (home: string) => join(home, "approvals.yaml");

/** Read once when verdandid starts, like `review.yaml`. A broken file stops it, naming the file and key. */
export const loadApprovalSettings = (home: string) => {
  const file = approvalsSettingsFile(home);
  if (!existsSync(file)) return { smart: false };
  try {
    const data = Schema.decodeUnknownSync(ApprovalsFile)(Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}, { onExcessProperty: "error" });
    return { smart: data.smart ?? false };
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}\nFix the file (it takes smart: true or false), or delete it.`);
  }
};
