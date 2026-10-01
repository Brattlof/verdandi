import { expect, test } from "bun:test";
import { containsSecret, redact } from "./redact.ts";

test("masks secrets in strings and under secret-named keys, and leaves the rest alone", () => {
  const key = `sk-ant-api03-${"a".repeat(40)}`;
  const input = {
    content: `ANTHROPIC_API_KEY=${key}\ncurl -H "Authorization: Bearer ${"b".repeat(32)}" https://bob:hunter22@example.com`,
    input: { apiKey: "short", file_path: "src/token-counter.ts" },
    inputTokens: 1200,
  };
  const out = redact(input);
  expect(out.content).toBe('ANTHROPIC_API_KEY=[REDACTED]\ncurl -H "Authorization: Bearer [REDACTED]" https://bob:[REDACTED]@example.com');
  expect(out.input).toEqual({ apiKey: "[REDACTED]", file_path: "src/token-counter.ts" });
  expect(out.inputTokens).toBe(1200);
  expect(input.input.apiKey).toBe("short");
});

test("masks a secret under a quoted name, keeping the name and its quotes", () => {
  const value = "abcd1234efgh5678";
  expect(redact(`{"apiKey": "${value}", "name": "${value}"}`)).toBe(`{"apiKey": "[REDACTED]", "name": "${value}"}`);
  expect(redact(`  "GITHUB_TOKEN" : "${value}",`)).toBe('  "GITHUB_TOKEN" : "[REDACTED]",');
  expect(redact(`{'client_secret': '${value}'}`)).toBe("{'client_secret': '[REDACTED]'}");
  expect(containsSecret(`{"password":"${value}"}`)).toBe(true);
  expect(containsSecret(`{"password": "short"}`)).toBe(false);
});
