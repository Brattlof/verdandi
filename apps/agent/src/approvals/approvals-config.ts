import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AccessLevel } from "@verdandi/contracts";
import { Schema } from "effect";

/**
 * `approvals.yaml` in the Verdandi home (DESIGN §17): `access` is the access level of threads that don't set their own,
 * `ask` until the user chooses another (§23's question 3 stays open).
 */
const ApprovalsFile = Schema.Struct({ access: Schema.optionalKey(AccessLevel) });

export const approvalsSettingsFile = (home: string) => join(home, "approvals.yaml");

/** Read once when verdandid starts, like `review.yaml`. A broken file stops it, naming the file and key. */
export const loadApprovalSettings = (home: string): { readonly access: AccessLevel } => {
  const file = approvalsSettingsFile(home);
  if (!existsSync(file)) return { access: "ask" };
  try {
    const data = Schema.decodeUnknownSync(ApprovalsFile)(Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}, { onExcessProperty: "error" });
    return { access: data.access ?? "ask" };
  } catch (e) {
    throw new Error(
      `${file}: ${e instanceof Error ? e.message : String(e)}\nFix the file (it takes access: ask, auto or full; smart: true is now access: auto), or delete it.`,
    );
  }
};
