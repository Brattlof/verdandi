/**
 * Where the native harness's Anthropic API key lives (ADR 0022). Not `ANTHROPIC_API_KEY`: Claude Code inherits
 * verdandid's environment, and that variable would quietly move its turns from the subscription to metered billing.
 */
export const keyVariable = "VERDANDI_ANTHROPIC_API_KEY";
/** Verdandi's own secrets in its environment, kept from every process it starts. Each provider's key variable goes here. */
export const secretVariables = [keyVariable];
export const keychainEntry = { service: "verdandi", name: "anthropic-api-key" } as const;

/** The OS keychain as `Bun.secrets` exposes it; tests pass their own, never the real one. */
export type SecretStore = {
  readonly get: (entry: { service: string; name: string }) => Promise<string | null>;
  readonly set: (entry: { service: string; name: string; value: string }) => Promise<void>;
  readonly delete: (entry: { service: string; name: string }) => Promise<boolean>;
};

const setKey = "`verdandi key set anthropic`";

/** Why `key` can't be an Anthropic API key, or undefined when it looks like one. Never quotes the key. */
export const keyProblem = (key: string) => {
  if (key === "") return "it is empty";
  if (/\s/.test(key)) return "it contains whitespace";
  if (!key.startsWith("sk-ant-")) return "it doesn't start with sk-ant-, as Anthropic API keys do";
  return undefined;
};

/**
 * The key for the native harness: `VERDANDI_ANTHROPIC_API_KEY` from the environment (Bun loads `.env`), else the OS
 * keychain. With neither, or a keychain that can't be read, `key` is undefined and `reason` says why and how to add
 * one. A key that is there but malformed throws, naming where it is and the fix. No message ever holds the key.
 */
export const findAnthropicKey = async (
  env: Readonly<Record<string, string | undefined>>,
  secrets: SecretStore,
): Promise<{ readonly key: string; readonly source: string } | { readonly key: undefined; readonly reason: string }> => {
  const fromEnv = env[keyVariable];
  if (fromEnv !== undefined) {
    const problem = keyProblem(fromEnv.trim());
    if (problem) throw new Error(`${keyVariable} is set, but ${problem}. Fix it in your environment or .env, or unset it.`);
    return { key: fromEnv.trim(), source: keyVariable };
  }
  let stored: string | null;
  try {
    stored = await secrets.get(keychainEntry);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { key: undefined, reason: `the OS keychain can't be read (${why}). Set ${keyVariable} in .env instead.` };
  }
  if (stored === null) return { key: undefined, reason: `no Anthropic API key. Add one with ${setKey}, or set ${keyVariable}.` };
  const problem = keyProblem(stored);
  if (problem) throw new Error(`The Anthropic API key in the OS keychain is unusable: ${problem}. Replace it with ${setKey}.`);
  return { key: stored, source: "the OS keychain" };
};
