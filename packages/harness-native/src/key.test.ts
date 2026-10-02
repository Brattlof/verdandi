import { expect, test } from "bun:test";
import { findAnthropicKey, type SecretStore } from "./key.ts";

/** A keychain holding `stored`, or one that can't be read at all. Tests never touch the real one. */
const keychain = (stored: string | null | Error): SecretStore => ({
  get: async () => {
    if (stored instanceof Error) throw stored;
    return stored;
  },
  set: async () => {},
  delete: async () => false,
});

test("the key comes from VERDANDI_ANTHROPIC_API_KEY first, then the keychain; with neither the native harness stays off", async () => {
  expect(await findAnthropicKey({ VERDANDI_ANTHROPIC_API_KEY: " sk-ant-env\n" }, keychain("sk-ant-chain"))).toEqual({
    key: "sk-ant-env",
    source: "VERDANDI_ANTHROPIC_API_KEY",
  });
  expect(await findAnthropicKey({}, keychain("sk-ant-chain"))).toEqual({ key: "sk-ant-chain", source: "the OS keychain" });
  // ANTHROPIC_API_KEY is Claude Code's: reading it would bill its turns as metered.
  const none = await findAnthropicKey({ ANTHROPIC_API_KEY: "sk-ant-claude-code" }, keychain(null));
  expect(none.key).toBeUndefined();
  expect("reason" in none && none.reason).toContain("verdandi key set anthropic");
  const unreadable = await findAnthropicKey({}, keychain(new Error("libsecret is not installed")));
  expect("reason" in unreadable && unreadable.reason).toContain("libsecret is not installed");
});

test("a key that is there but malformed fails loudly, naming where it is and the fix, without quoting it", async () => {
  await expect(findAnthropicKey({ VERDANDI_ANTHROPIC_API_KEY: "" }, keychain(null))).rejects.toThrow(
    "VERDANDI_ANTHROPIC_API_KEY is set, but it is empty",
  );
  const wrong = findAnthropicKey({}, keychain("ghp_secretvalue"));
  await expect(wrong).rejects.toThrow("Replace it with `verdandi key set anthropic`");
  await expect(wrong).rejects.not.toThrow("ghp_secretvalue");
});
