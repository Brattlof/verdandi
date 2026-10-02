/**
 * `text` cut to at most `max` code points for display: past that, its first `max - 1`, trailing whitespace trimmed,
 * then `…`. Counting code points rather than UTF-16 units never splits an emoji, and only the head is walked.
 */
export const clip = (text: string, max: number) => {
  let count = 0;
  let end = 0; // where the first `max - 1` code points end
  for (const char of text) {
    if (++count > max) return `${text.slice(0, end).trimEnd()}…`;
    if (count < max) end += char.length;
  }
  return text;
};

/**
 * `index`, moved back one when it falls between the two halves of a surrogate pair: for cuts measured in UTF-16
 * units (a size budget, a tail), so the piece kept starts and ends on a whole character.
 */
export const codePointStart = (text: string, index: number) => ((text.codePointAt(index - 1) ?? 0) > 0xffff ? index - 1 : index);

export type TextLine = { readonly line: "context" | "del" | "add"; readonly text: string };

const linesOf = (text: string) => (text.trimEnd() === "" ? [] : text.trimEnd().split(/\r?\n/));

/** `after` against `before` line by line, shared lines as context: for short texts like a plan or a skill file. Empty text has no lines. */
// ponytail: an O(n·m) table of common lines, fine for plans and skill files (capped at 64 KiB). Upgrade to Myers' diff if it diffs bigger files.
export const lineDiff = (before: string, after: string): TextLine[] => {
  const a = linesOf(before);
  const b = linesOf(after);
  const w = b.length + 1;
  // How many lines a[i..] and b[j..] share, in order.
  const common = new Uint32Array((a.length + 1) * w);
  const at = (i: number, j: number) => common[i * w + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) common[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
  const lines: TextLine[] = [];
  let [i, j] = [0, 0];
  while (i < a.length || j < b.length) {
    const [x, y] = [a[i], b[j]];
    if (x !== undefined && x === y) {
      lines.push({ line: "context", text: x });
      i++;
      j++;
    } else if (x !== undefined && (y === undefined || at(i + 1, j) >= at(i, j + 1))) {
      lines.push({ line: "del", text: x });
      i++;
    } else {
      lines.push({ line: "add", text: y ?? "" });
      j++;
    }
  }
  return lines;
};
