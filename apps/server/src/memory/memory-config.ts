import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";

/** `memory.yaml` in the Verdandi home: `approveSaves: true` makes the user approve each memory the agent saves. */
const MemoryFile = Schema.Struct({ approveSaves: Schema.optionalKey(Schema.Boolean) });

export const memorySettingsFile = (home: string) => join(home, "memory.yaml");

/** Read once when verdandid starts, since the tool list is fixed per session. A broken file stops it, naming the file and key. */
export const loadMemorySettings = (home: string) => {
  const file = memorySettingsFile(home);
  if (!existsSync(file)) return { approveSaves: false };
  try {
    const data = Schema.decodeUnknownSync(MemoryFile)(Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}, { onExcessProperty: "error" });
    return { approveSaves: data.approveSaves ?? false };
  } catch (e) {
    throw new Error(
      `${file}: ${e instanceof Error ? e.message : String(e)}\nFix the file (it takes approveSaves: true or false), or delete it.`,
    );
  }
};
