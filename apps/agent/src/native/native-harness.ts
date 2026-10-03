import { join } from "node:path";
import { findAnthropicKey, makeNativeAdapter, type SecretStore } from "@verdandi/harness-native";
import { attachmentsDir } from "../attachments/attachments.ts";
import { forgetSecrets } from "../home/child-env.ts";

/** Where the native harness keeps its sessions' transcripts (ADR 0022). */
export const nativeSessionsDir = (home: string) => join(home, "native-sessions");

/**
 * The native harness, when an Anthropic API key is configured (ADR 0022), and a line saying whether it runs and
 * where its key came from, never the key. A key that's there but malformed throws, naming where it is and the fix.
 * The key leaves `env` once read: verdandid keeps it in memory only, out of reach of the processes it starts (`childEnv`).
 * Its file tools work in a thread's folder and `folders` (`workspace.yaml`), and never in the rest of `home`.
 */
export const nativeHarness = async (
  home: string,
  folders: readonly string[],
  env: Record<string, string | undefined> = process.env,
  secrets: SecretStore = Bun.secrets,
) => {
  const found = await findAnthropicKey(env, secrets);
  forgetSecrets(env);
  if (found.key === undefined) return { adapter: undefined, status: `Native harness off: ${found.reason}` };
  return {
    adapter: makeNativeAdapter({
      apiKey: found.key,
      sessionsDir: nativeSessionsDir(home),
      reach: { home, folders, attachments: attachmentsDir(home) },
    }),
    status: `Native harness on (Anthropic API, metered), with the key from ${found.source}.`,
  };
};
