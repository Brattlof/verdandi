import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CatalogEntry, Effort, Tier } from "@verdandi/contracts";
import { type Endpoint, findEndpointKey, nativeCatalog, type SecretStore } from "@verdandi/harness-native";
import { Schema } from "effect";

const Model = Schema.Struct({
  tier: Tier,
  context: Schema.Int,
  vision: Schema.optionalKey(Schema.Boolean),
  efforts: Schema.optionalKey(Schema.Array(Effort)),
  /** $/MTok. A local endpoint's models cost nothing unless priced; cached input defaults to the input price. */
  price: Schema.optionalKey(
    Schema.Struct({
      input: Schema.Number,
      output: Schema.Number,
      cacheRead: Schema.optionalKey(Schema.Number),
      cacheWrite: Schema.optionalKey(Schema.Number),
    }),
  ),
});

/** `providers.yaml` in the Verdandi home: the OpenAI-compatible endpoints the native harness may use, by name. */
const ProvidersFile = Schema.Struct({
  endpoints: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({ url: Schema.String, access: Schema.Literals(["local", "metered"]), models: Schema.Record(Schema.String, Model) }),
    ),
  ),
});

export const providersFile = (home: string) => join(home, "providers.yaml");

const example = `endpoints:
  ollama:
    url: http://127.0.0.1:11434/v1
    access: local
    models:
      qwen3:8b: { tier: S, context: 32768 }`;

const failIn = (file: string, message: string): never => {
  throw new Error(`${file}: ${message}
Fix the file, or delete it. It looks like this:
${example}`);
};

/**
 * The endpoints in `providers.yaml` with their models as native catalog entries (provider: the endpoint's name), or
 * none without the file. A broken file throws, naming the file and key.
 */
const readEndpoints = (home: string) => {
  const file = providersFile(home);
  if (!existsSync(file)) return [];
  const fail = (message: string): never => failIn(file, message);
  let data: typeof ProvidersFile.Type = {};
  try {
    data = Schema.decodeUnknownSync(ProvidersFile)(Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}, { onExcessProperty: "error" });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  const seen = new Map(nativeCatalog.map((e) => [e.model, "the Anthropic API"]));
  return Object.entries(data.endpoints ?? {}).map(([id, endpoint]) => {
    const at = `endpoints.${id}`;
    if (!/^[a-z][a-z0-9-]*$/.test(id)) fail(`${at}: a name is lowercase letters, digits and dashes, starting with a letter.`);
    if (id === "anthropic") fail(`${at}: anthropic is the native harness's own provider; name this endpoint something else.`);
    let url: URL | undefined;
    try {
      url = new URL(endpoint.url);
    } catch {}
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:"))
      fail(`${at}.url: ${endpoint.url} isn't an http(s) URL, e.g. http://127.0.0.1:11434/v1.`);
    if (Object.keys(endpoint.models).length === 0) fail(`${at}.models: list at least one model the endpoint serves.`);
    const models = Object.entries(endpoint.models).map(([model, m]): CatalogEntry => {
      const where = `${at}.models.${model}`;
      const other = seen.get(model);
      if (other) fail(`${where}: ${other} already serves a model by this name; the native harness picks a provider by model name.`);
      seen.set(model, `endpoint ${id}`);
      if (endpoint.access === "metered" && !m.price)
        fail(`${where}.price: a metered endpoint's model needs its $/MTok price, e.g. { input: 0.2, output: 0.8 }.`);
      const price = m.price ?? { input: 0, output: 0 };
      return {
        harness: "native",
        provider: id,
        model,
        access: endpoint.access,
        tier: m.tier,
        context: m.context,
        vision: m.vision ?? false,
        efforts: m.efforts ?? [],
        price: {
          input: price.input,
          output: price.output,
          cacheRead: price.cacheRead ?? price.input,
          cacheWrite: price.cacheWrite ?? price.input,
        },
      };
    });
    return { id, url: endpoint.url, access: endpoint.access, models };
  });
};

/** The names of the endpoints in `providers.yaml`, for `verdandi key`. */
export const endpointNames = (home: string) => readEndpoints(home).map((e) => e.id);

/** Every model in `providers.yaml`, keys or not: what `verdandi routing replay` may find a recorded task ran on. */
export const endpointCatalog = (home: string) => readEndpoints(home).flatMap((e) => e.models);

/**
 * The Chat Completions endpoints in `providers.yaml`, read when verdandid starts (ADR 0035). A broken file throws,
 * naming the file and key. Keys come from `VERDANDI_<NAME>_API_KEY` or the keychain; a metered endpoint without one
 * stays off, and `off` says why.
 */
export const loadEndpoints = async (
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  secrets: SecretStore,
): Promise<{ readonly endpoints: readonly Endpoint[]; readonly off: readonly string[] }> => {
  const endpoints: Endpoint[] = [];
  const off: string[] = [];
  for (const { id, url, access, models } of readEndpoints(home)) {
    const found = await findEndpointKey(id, env, secrets);
    if (found.key === undefined && access === "metered") off.push(`${id}: ${found.reason}`);
    else endpoints.push({ id, url, key: found.key, models });
  }
  return { endpoints, off };
};
