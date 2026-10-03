import { expect, test } from "bun:test";
import { Readable } from "node:stream";
import type { SecretStore } from "@verdandi/harness-native";
import { readHidden, runKey } from "./key-cli.ts";

/** An in-memory keychain: tests never touch the real one. */
const memoryStore = () => {
  const entries = new Map<string, string>();
  const at = (e: { service: string; name: string }) => `${e.service}/${e.name}`;
  const store: SecretStore = {
    get: async (e) => entries.get(at(e)) ?? null,
    set: async (e) => void entries.set(at(e), e.value),
    delete: async (e) => entries.delete(at(e)),
  };
  return { store, entries };
};

const key = "sk-ant-api03-test-key";

test("`verdandi key set anthropic` stores the key in the keychain and never prints it; delete removes it", async () => {
  const { store, entries } = memoryStore();
  const lines: string[] = [];
  const io = { secrets: store, readKey: async () => ` ${key}\n`, out: (l: string) => void lines.push(l), env: {} };
  await runKey(["set", "anthropic"], io);
  expect(entries.get("verdandi/anthropic-api-key")).toBe(key);
  await runKey(["delete", "anthropic"], io);
  expect(entries.size).toBe(0);
  expect(lines).toHaveLength(2);
  expect(lines.join("\n")).not.toContain(key);
});

test("a malformed key is refused and nothing is stored; a set variable that shadows the keychain is named", async () => {
  const { store, entries } = memoryStore();
  const lines: string[] = [];
  const io = { secrets: store, readKey: async () => "not a key", out: (l: string) => void lines.push(l), env: {} };
  await expect(runKey(["set", "anthropic"], io)).rejects.toThrow("Nothing was stored");
  await expect(runKey(["set", "openai"], io)).rejects.toThrow("verdandi key set anthropic");
  expect(entries.size).toBe(0);
  await runKey(["set", "anthropic"], { ...io, readKey: async () => key, env: { VERDANDI_ANTHROPIC_API_KEY: "sk-ant-other" } });
  expect(lines.at(-1)).toContain("VERDANDI_ANTHROPIC_API_KEY is set too");
});

test("the key is read up to Enter or the end of piped input, with Backspace applied", async () => {
  const prompts: string[] = [];
  expect(await readHidden(Readable.from(["sk-ant-ab", "x\u007fc\rleftover"]), (t) => void prompts.push(t))).toBe("sk-ant-abc");
  expect(await readHidden(Readable.from(["sk-ant-piped"]), (t) => void prompts.push(t))).toBe("sk-ant-piped");
  // Piped input isn't a terminal: no prompt, nothing echoed.
  expect(prompts).toEqual([]);
});
