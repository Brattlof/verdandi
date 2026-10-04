import { endpointKeyProblem, keyPlaces, keyProblem, type SecretStore } from "@verdandi/harness-native";
import { resolveHome } from "../home/home.ts";
import { endpointNames } from "./endpoints.ts";

type HiddenInput = NodeJS.ReadableStream & { readonly isTTY?: boolean; setRawMode?: (on: boolean) => unknown };

/**
 * Reads one line without echoing it: keypress by keypress in raw mode on a terminal, or whatever is piped in.
 * Enter (or the end of piped input) finishes; Backspace deletes; Ctrl+C cancels.
 */
export const readHidden = (input: HiddenInput, prompt: (text: string) => void) =>
  new Promise<string>((resolve, reject) => {
    const tty = input.isTTY === true && typeof input.setRawMode === "function";
    let value = "";
    const finish = (settle: () => void) => {
      input.off("data", onData);
      input.off("end", onEnd);
      if (tty) {
        input.setRawMode?.(false);
        prompt("\n");
      }
      input.pause();
      settle();
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString()) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish(() => resolve(value));
        if (ch === "\u0003") return finish(() => reject(new Error("Cancelled; nothing was stored.")));
        value = ch === "\u007f" || ch === "\b" ? value.slice(0, -1) : value + ch;
      }
    };
    const onEnd = () => finish(() => resolve(value));
    if (tty) {
      prompt("API key (it won't show as you type or paste): ");
      input.setRawMode?.(true);
    }
    input.on("data", onData);
    input.on("end", onEnd);
    input.resume();
  });

const usageOf = (endpoints: readonly string[]) =>
  `verdandi key takes \`set <provider>\` or \`delete <provider>\`, where the provider is anthropic${endpoints.map((e) => ` or ${e}`).join("")} (the endpoints in providers.yaml), e.g. verdandi key set anthropic`;

/**
 * `verdandi key set|delete <provider>`: stores the API key of the native harness's Anthropic provider (ADR 0022), or of
 * an endpoint in `providers.yaml` (ADR 0035), in the OS keychain, or removes it. The key is read without echo and never
 * printed. Tests pass their own store, never the real keychain.
 */
export const runKey = async (
  argv: readonly string[],
  io: {
    readonly secrets: SecretStore;
    readonly readKey: () => Promise<string>;
    readonly out: (line: string) => void;
    readonly env: Readonly<Record<string, string | undefined>>;
    /** The endpoints in `providers.yaml`, whose keys it may store too. */
    readonly endpoints?: readonly string[];
  },
) => {
  const endpoints = io.endpoints ?? [];
  const [action, provider = "", ...rest] = argv;
  if (!(provider === "anthropic" || endpoints.includes(provider)) || rest.length > 0 || (action !== "set" && action !== "delete"))
    throw new Error(usageOf(endpoints));
  const anthropic = provider === "anthropic";
  const label = anthropic ? "the Anthropic API key" : `the API key for ${provider}`;
  const { variable, entry } = keyPlaces(provider);
  const shadowed =
    io.env[variable] === undefined ? "" : ` ${variable} is set too, and verdandid uses it over the keychain; unset it to use this one.`;
  if (action === "delete") {
    const deleted = await io.secrets.delete(entry);
    io.out(
      deleted
        ? `Removed ${label} from the OS keychain. Restart verdandid to stop using it.`
        : `The OS keychain has no ${anthropic ? "Anthropic API key" : `API key for ${provider}`}.`,
    );
    return;
  }
  const key = (await io.readKey()).trim();
  const problem = (anthropic ? keyProblem : endpointKeyProblem)(key);
  if (problem)
    throw new Error(`That isn't ${anthropic ? "an Anthropic API key" : `an API key for ${provider}`}: ${problem}. Nothing was stored.`);
  await io.secrets.set({ ...entry, value: key });
  io.out(`Stored ${label} in the OS keychain. Restart verdandid to use it.${shadowed}`);
};

export const key = (argv: readonly string[]) => {
  const home = resolveHome(argv);
  // `--home <dir>` or `--home=<dir>` may come anywhere; the rest is the action and the provider.
  const positional = argv.filter((a, i) => !a.startsWith("--home") && argv[i - 1] !== "--home");
  return runKey(positional, {
    secrets: Bun.secrets,
    readKey: () => readHidden(process.stdin, (text) => process.stderr.write(text)),
    out: (line) => console.log(line),
    env: process.env,
    endpoints: endpointNames(home),
  });
};
