import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";

/**
 * `memory.yaml` in the Verdandi home: `approveSaves: true` makes the user approve each memory the agent saves;
 * `nudgeEvery: <n>` reminds the agent to consider saving one every n turns of a thread (default 10, 0 never).
 */
const MemoryFile = Schema.Struct({
  approveSaves: Schema.optionalKey(Schema.Boolean),
  nudgeEvery: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

export const memorySettingsFile = (home: string) => join(home, "memory.yaml");

/** Read once when verdandid starts, since the tool list is fixed per session. A broken file stops it, naming the file and key. */
export const loadMemorySettings = (home: string) => {
  const file = memorySettingsFile(home);
  if (!existsSync(file)) return { approveSaves: false, nudgeEvery: 10 };
  try {
    const data = Schema.decodeUnknownSync(MemoryFile)(Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}, { onExcessProperty: "error" });
    return { approveSaves: data.approveSaves ?? false, nudgeEvery: data.nudgeEvery ?? 10 };
  } catch (e) {
    throw new Error(
      `${file}: ${e instanceof Error ? e.message : String(e)}\nFix the file (it takes approveSaves: true or false, and nudgeEvery: a whole number of turns, 0 for never), or delete it.`,
    );
  }
};
