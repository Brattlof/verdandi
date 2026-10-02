/** A path: Unix, Windows (`C:\…`), home- or dot-relative, up to whitespace, quotes, brackets and `:` (line numbers). */
const paths = /(?:[A-Za-z]:|~|\.{1,2})?(?:[\\/][^\s\\/:'"`,;()[\]{}<>]+)+[\\/]?/g;
/** A token of 8 or more characters mixing letters and digits: UUIDs, hashes, tool-use and request ids. */
const ids = /\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{8,}\b/g;

/**
 * A tool error with what changes between otherwise identical failures stripped (paths, ids, then any other numbers
 * such as line numbers) and its whitespace collapsed, so two of them compare equal when they're the same error.
 */
export const normalizeError = (text: string) =>
  text.replace(paths, "<path>").replace(ids, "<id>").replace(/\d+/g, "<n>").replace(/\s+/g, " ").trim();

/** The most an escalation hands the agent of the repeated error; the start of an error says what it is. */
const maxErrorChars = 4000;

/**
 * The tool error in `errors` (a task's failed tool results since it last escalated, oldest first) that came back at
 * least `n` times, as a `repeated-error` escalation trigger with its latest text (DESIGN §8.7); undefined when none
 * did, or `n` is 0. The most repeated wins.
 */
export const repeatedError = (errors: readonly { readonly tool: string; readonly error: string }[], n: number) => {
  const seen = new Map<string, { tool: string; error: string; count: number }>();
  for (const { tool, error } of errors) {
    const key = `${tool}\0${normalizeError(error)}`;
    seen.set(key, { tool, error, count: (seen.get(key)?.count ?? 0) + 1 });
  }
  const top = [...seen.values()].reduce<{ tool: string; error: string; count: number } | undefined>(
    (best, e) => (e.count > (best?.count ?? 0) ? e : best),
    undefined,
  );
  if (n === 0 || !top || top.count < n) return undefined;
  const error = top.error.length > maxErrorChars ? `${top.error.slice(0, maxErrorChars)}\n…` : top.error;
  return { kind: "repeated-error", tool: top.tool, error, count: top.count } as const;
};
