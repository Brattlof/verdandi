const MASK = "[REDACTED]";

// ponytail: a fixed list of well-known token shapes plus secret-looking names; a novel token format
// slips through. Upgrade to a maintained rule set (gitleaks-style) before trajectories can be exported.
const patterns: readonly [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, MASK], // Anthropic, OpenAI
  [/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, MASK],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{35}/g, MASK],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g, MASK],
  [/\b(?:npm_[A-Za-z0-9]{36}|hf_[A-Za-z]{34})\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, MASK], // JWT
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, `$1${MASK}`],
  [/(:\/\/[^/\s:@]+:)[^/\s@]+@/g, `$1${MASK}@`], // credentials in a URL
  [/\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY)[A-Za-z0-9_]*\s*[=:]\s*["']?)[^\s"']{8,}/gi, `$1${MASK}`],
];

/** An object key whose string value is a secret, e.g. `{ "apiKey": "…" }` in a tool call's input. */
const secretKey = /secret|token|password|passwd|api_?key|authorization|credential/i;

const redactText = (text: string) => patterns.reduce((s, [pattern, replacement]) => s.replace(pattern, replacement), text);

/** Whether `text` holds something the redactor would mask: memory refuses to save it (DESIGN §14.2). */
export const containsSecret = (text: string) => redactText(text) !== text;

/** Pure: a copy of `value` with secrets in its strings masked. Run on anything before it is written to a trajectory. */
export const redact = <T>(value: T): T => {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== "object") return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "string" && secretKey.test(k) ? MASK : walk(x)]));
  };
  return walk(value) as T;
};
