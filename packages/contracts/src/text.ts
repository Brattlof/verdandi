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
