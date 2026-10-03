import { keychainEntry, keyProblem, keyVariable, type SecretStore } from "@verdandi/harness-native";

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
      prompt("Anthropic API key (it won't show as you type or paste): ");
      input.setRawMode?.(true);
    }
    input.on("data", onData);
    input.on("end", onEnd);
    input.resume();
  });

const usage = "verdandi key takes `set anthropic` or `delete anthropic`, e.g. verdandi key set anthropic";

/**
 * `verdandi key set|delete anthropic`: stores the native harness's Anthropic API key in the OS keychain, or removes it
 * (ADR 0022). The key is read without echo and never printed. Tests pass their own store, never the real keychain.
 */
export const runKey = async (
  argv: readonly string[],
  io: {
    readonly secrets: SecretStore;
    readonly readKey: () => Promise<string>;
    readonly out: (line: string) => void;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
) => {
  const [action, provider, ...rest] = argv;
  if (provider !== "anthropic" || rest.length > 0 || (action !== "set" && action !== "delete")) throw new Error(usage);
  const shadowed =
    io.env[keyVariable] === undefined
      ? ""
      : ` ${keyVariable} is set too, and verdandid uses it over the keychain; unset it to use this one.`;
  if (action === "delete") {
    const deleted = await io.secrets.delete(keychainEntry);
    io.out(
      deleted
        ? "Removed the Anthropic API key from the OS keychain. Restart verdandid to turn the native harness off."
        : "The OS keychain has no Anthropic API key.",
    );
    return;
  }
  const key = (await io.readKey()).trim();
  const problem = keyProblem(key);
  if (problem) throw new Error(`That isn't an Anthropic API key: ${problem}. Nothing was stored.`);
  await io.secrets.set({ ...keychainEntry, value: key });
  io.out(`Stored the Anthropic API key in the OS keychain. Restart verdandid to run the native harness.${shadowed}`);
};

export const key = (argv: readonly string[]) =>
  runKey(argv, {
    secrets: Bun.secrets,
    readKey: () => readHidden(process.stdin, (text) => process.stderr.write(text)),
    out: (line) => console.log(line),
    env: process.env,
  });
