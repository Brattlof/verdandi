import { isSecretVariable } from "@verdandi/harness-native";

/**
 * The environment for a process Verdandi starts: its own, without Verdandi's provider keys (`VERDANDI_<PROVIDER>_API_KEY`,
 * `isSecretVariable`), so no harness, verifier, shell or editor can read them. Every spawn passes it: `Bun.spawn` without `env` hands the
 * child the environment this process started with, `.env` included, even once a secret is gone from `process.env`.
 * Names compare case-insensitively, as Windows does.
 */
export const childEnv = (extra: Record<string, string> = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !isSecretVariable(name))),
  ...extra,
});

/** Takes Verdandi's secrets out of `env` once read, so code that copies `process.env` can't pass them on either. */
export const forgetSecrets = (env: Record<string, string | undefined>) => {
  for (const name of Object.keys(env)) if (isSecretVariable(name)) delete env[name];
};
