import { keychainEntry, keyProblem, keyVariable, type SecretStore } from "@verdandi/harness-native";
import { telegramKeychainEntry, telegramTokenProblem, telegramTokenVariable } from "../gateway/telegram.ts";

type HiddenInput = NodeJS.ReadableStream & { readonly isTTY?: boolean; setRawMode?: (on: boolean) => unknown };

/**
 * Reads one line without echoing it: keypress by keypress in raw mode on a terminal, or whatever is piped in.
 * Enter (or the end of piped input) finishes; Backspace deletes; Ctrl+C cancels.
 */
export const readHidden = (input: HiddenInput, prompt: (text: string) => void, label = "Anthropic API key") =>
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
      prompt(`${label} (it won't show as you type or paste): `);
      input.setRawMode?.(true);
    }
    input.on("data", onData);
    input.on("end", onEnd);
    input.resume();
  });

const usage =
  "verdandi key takes `set anthropic`, `delete anthropic`, `set telegram` or `delete telegram`, e.g. verdandi key set anthropic";

/** Each secret `verdandi key` keeps, what it's for, and what verdandid does with it once stored. */
const secrets = {
  anthropic: {
    label: "Anthropic API key",
    entry: keychainEntry,
    variable: keyVariable,
    problem: keyProblem,
    stored: "Restart verdandid to run the native harness.",
    deleted: "Restart verdandid to turn the native harness off.",
  },
  telegram: {
    label: "Telegram bot token",
    entry: telegramKeychainEntry,
    variable: telegramTokenVariable,
    problem: telegramTokenProblem,
    stored: "Restart verdandi start to connect Telegram; gateway.yaml says who may use it.",
    deleted: "Restart verdandi start to disconnect Telegram.",
  },
} as const;

/**
 * `verdandi key set|delete anthropic|telegram`: stores the native harness's Anthropic API key (ADR 0022) or the
 * gateway's Telegram bot token (DESIGN §15) in the OS keychain, or removes it. It's read without echo and never
 * printed. Tests pass their own store, never the real keychain.
 */
export const runKey = async (
  argv: readonly string[],
  io: {
    readonly secrets: SecretStore;
    readonly readKey: (label: string) => Promise<string>;
    readonly out: (line: string) => void;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
) => {
  const [action, which = "", ...rest] = argv;
  if (!Object.hasOwn(secrets, which) || rest.length > 0 || (action !== "set" && action !== "delete")) throw new Error(usage);
  const secret = secrets[which as keyof typeof secrets];
  const shadowed =
    io.env[secret.variable] === undefined
      ? ""
      : ` ${secret.variable} is set too, and verdandid uses it over the keychain; unset it to use this one.`;
  if (action === "delete") {
    const deleted = await io.secrets.delete(secret.entry);
    io.out(deleted ? `Removed the ${secret.label} from the OS keychain. ${secret.deleted}` : `The OS keychain has no ${secret.label}.`);
    return;
  }
  const key = (await io.readKey(secret.label)).trim();
  const problem = secret.problem(key);
  if (problem) throw new Error(`That isn't a ${secret.label}: ${problem}. Nothing was stored.`);
  await io.secrets.set({ ...secret.entry, value: key });
  io.out(`Stored the ${secret.label} in the OS keychain. ${secret.stored}${shadowed}`);
};

export const key = (argv: readonly string[]) =>
  runKey(argv, {
    secrets: Bun.secrets,
    readKey: (label) => readHidden(process.stdin, (text) => process.stderr.write(text), label),
    out: (line) => console.log(line),
    env: process.env,
  });
