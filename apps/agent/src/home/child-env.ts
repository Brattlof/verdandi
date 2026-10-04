import { secretVariables } from "@verdandi/harness-native";
import { telegramTokenVariable } from "../gateway/telegram.ts";

const secret = new Set([...secretVariables, telegramTokenVariable].map((name) => name.toUpperCase()));

/**
 * The environment for a process Verdandi starts: its own, without Verdandi's secrets (`secretVariables`), so no
 * harness, verifier, shell or editor can read them. Every spawn passes it: `Bun.spawn` without `env` hands the
 * child the environment this process started with, `.env` included, even once a secret is gone from `process.env`.
 * Names compare case-insensitively, as Windows does.
 */
export const childEnv = (extra: Record<string, string> = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !secret.has(name.toUpperCase()))),
  ...extra,
});

/** Takes Verdandi's secrets out of `env` once read, so code that copies `process.env` can't pass them on either. */
export const forgetSecrets = (env: Record<string, string | undefined>) => {
  for (const name of Object.keys(env)) if (secret.has(name.toUpperCase())) delete env[name];
};
