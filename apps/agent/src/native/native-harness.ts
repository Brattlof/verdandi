import { join } from "node:path";
import { findAnthropicKey, makeNativeAdapter, type SecretStore } from "@verdandi/harness-native";
import { Effect } from "effect";
import { attachmentsDir } from "../attachments/attachments.ts";
import { forgetSecrets } from "../home/child-env.ts";
import { readableSkills } from "../skills/skill-files.ts";
import { loadSkillFolders } from "../skills/skills-config.ts";
import { runShell } from "../verifiers/verify.ts";
import { loadEndpoints } from "./endpoints.ts";

/** Where the native harness keeps its sessions' transcripts (ADR 0022). */
export const nativeSessionsDir = (home: string) => join(home, "native-sessions");

/** Where the native terminal writes each command's whole output, for the agent's `read_file`. */
export const terminalOutputDir = (home: string) => join(home, "terminal-output");

/**
 * The native harness, when an Anthropic API key (ADR 0022) or an endpoint in `providers.yaml` (ADR 0035) is configured,
 * and a line saying whether it runs, on what, and where its keys came from, never a key. A key that's there but
 * malformed, or a broken `providers.yaml`, throws, naming where it is and the fix. Keys leave `env` once read: verdandid
 * keeps them in memory only, out of reach of the processes it starts (`childEnv`). Its file tools work in a thread's
 * folder and `folders` (`workspace.yaml`), and never in the rest of `home`; its terminal runs commands through
 * `runShell`, as verifiers do. A new session's skills index lists the profile's skills and the extra folders'
 * (`skills.yaml`).
 */
export const nativeHarness = async (
  home: string,
  folders: readonly string[],
  env: Record<string, string | undefined> = process.env,
  secrets: SecretStore = Bun.secrets,
) => {
  const found = await findAnthropicKey(env, secrets);
  const { endpoints, off } = await loadEndpoints(home, env, secrets);
  forgetSecrets(env);
  const offNote = off.length === 0 ? "" : ` Endpoints off: ${off.join("; ")}`;
  if (found.key === undefined && endpoints.length === 0)
    return { adapter: undefined, status: `Native harness off: ${found.reason}${offNote}` };
  const on = [
    ...(found.key === undefined ? [] : [`the Anthropic API (metered, with the key from ${found.source})`]),
    ...endpoints.map((e) => `${e.id} (${e.models[0]?.access}, ${e.models.length} model${e.models.length === 1 ? "" : "s"})`),
  ];
  const skillFolders = loadSkillFolders(home);
  return {
    adapter: makeNativeAdapter({
      ...(found.key !== undefined && { apiKey: found.key }),
      endpoints,
      sessionsDir: nativeSessionsDir(home),
      skills: () => readableSkills(skillFolders),
      reach: { home, folders, readable: [attachmentsDir(home)] },
      terminal: {
        // An interrupt aborts `signal`, which interrupts the run and kills the command's process tree.
        run: (command, cwd, { timeoutMs, outputFile, signal }) =>
          Effect.runPromise(runShell(command, cwd, { timeoutMs, outputFile }), { signal }),
        outputs: terminalOutputDir(home),
      },
    }),
    status: `Native harness on: ${on.join(", ")}.${found.key === undefined ? ` Anthropic off: ${found.reason}` : ""}${offNote}`,
  };
};
