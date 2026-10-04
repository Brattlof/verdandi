/**
 * Where a provider's API key lives (ADR 0022, ADR 0035): `VERDANDI_<PROVIDER>_API_KEY` in the environment (Bun loads
 * `.env`), else the OS keychain's `verdandi` / `<provider>-api-key`, which `verdandi key set <provider>` fills.
 */
export const keyPlaces = (provider: string) => ({
  variable: `VERDANDI_${provider.toUpperCase().replaceAll("-", "_")}_API_KEY`,
  entry: { service: "verdandi", name: `${provider}-api-key` },
});

/**
 * The native harness's Anthropic key variable. Not `ANTHROPIC_API_KEY`: Claude Code inherits verdandid's environment,
 * and that variable would quietly move its turns from the subscription to metered billing.
 */
export const keyVariable = keyPlaces("anthropic").variable;

/** Whether an environment variable holds one of Verdandi's own provider keys, kept from every process it starts. */
export const isSecretVariable = (name: string) => /^VERDANDI_\w+_API_KEY$/i.test(name);

/** The OS keychain as `Bun.secrets` exposes it; tests pass their own, never the real one. */
export type SecretStore = {
  readonly get: (entry: { service: string; name: string }) => Promise<string | null>;
  readonly set: (entry: { service: string; name: string; value: string }) => Promise<void>;
  readonly delete: (entry: { service: string; name: string }) => Promise<boolean>;
};

/** Why `key` can't be an API key for an endpoint, or undefined when it might be one. Never quotes the key. */
export const endpointKeyProblem = (key: string) => {
  if (key === "") return "it is empty";
  if (/\s/.test(key)) return "it contains whitespace";
  return undefined;
};

/** Why `key` can't be an Anthropic API key, or undefined when it looks like one. Never quotes the key. */
export const keyProblem = (key: string) =>
  endpointKeyProblem(key) ?? (key.startsWith("sk-ant-") ? undefined : "it doesn't start with sk-ant-, as Anthropic API keys do");

type Found = { readonly key: string; readonly source: string } | { readonly key: undefined; readonly reason: string };

/**
 * A provider's key from its variable, else the OS keychain. With neither, or a keychain that can't be read, `key` is
 * undefined and `reason` says why and how to add one. A key that is there but malformed throws, naming where it is and
 * the fix. No message ever holds the key.
 */
const findKey = async (
  provider: string,
  label: string,
  problemOf: (key: string) => string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  secrets: SecretStore,
): Promise<Found> => {
  const { variable, entry } = keyPlaces(provider);
  const setKey = `\`verdandi key set ${provider}\``;
  const fromEnv = env[variable];
  if (fromEnv !== undefined) {
    const problem = problemOf(fromEnv.trim());
    if (problem) throw new Error(`${variable} is set, but ${problem}. Fix it in your environment or .env, or unset it.`);
    return { key: fromEnv.trim(), source: variable };
  }
  let stored: string | null;
  try {
    stored = await secrets.get(entry);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { key: undefined, reason: `the OS keychain can't be read (${why}). Set ${variable} in .env instead.` };
  }
  if (stored === null) return { key: undefined, reason: `no ${label}. Add one with ${setKey}, or set ${variable}.` };
  const problem = problemOf(stored);
  if (problem) throw new Error(`The ${label} in the OS keychain is unusable: ${problem}. Replace it with ${setKey}.`);
  return { key: stored, source: "the OS keychain" };
};

/** The native harness's Anthropic API key (ADR 0022). */
export const findAnthropicKey = (env: Readonly<Record<string, string | undefined>>, secrets: SecretStore) =>
  findKey("anthropic", "Anthropic API key", keyProblem, env, secrets);

/** A Chat Completions endpoint's API key (ADR 0035), by the endpoint's name in `providers.yaml`. */
export const findEndpointKey = (endpoint: string, env: Readonly<Record<string, string | undefined>>, secrets: SecretStore) =>
  findKey(endpoint, `API key for ${endpoint}`, endpointKeyProblem, env, secrets);
