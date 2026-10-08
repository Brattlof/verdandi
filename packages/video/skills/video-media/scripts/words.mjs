#!/usr/bin/env node
// Caption words for a composition: [{ "text", "start", "end" }] in seconds, printed as JSON.
//
//   bun words.mjs whisper <transcript.json> [--offset <s>]
//       from whisper.cpp (`whisper-cli … -ml 1 -sow -oj`) or openai-whisper (`--word_timestamps True --output_format json`)
//   bun words.mjs script <script.txt> --duration <s> [--offset <s>]
//       no transcription: spreads the script's words over <s> seconds, longer words and pauses after punctuation
//       taking more time
//
// Runs under bun or node. --offset shifts every time (e.g. the voiceover's data-start, for root-level captions).
import { readFileSync } from "node:fs";

const [mode, file, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  const n = Number(rest[i + 1]);
  if (!Number.isFinite(n)) throw new Error(`${name} needs a number of seconds, e.g. ${name} 12.5`);
  return n;
};
if (!file || (mode !== "whisper" && mode !== "script")) {
  console.error("Usage: words.mjs whisper <transcript.json> | words.mjs script <script.txt> --duration <s>  [--offset <s>]");
  process.exit(2);
}
const offset = opt("--offset") ?? 0;
const round = (n) => Math.round(n * 1000) / 1000;

/** whisper.cpp: transcription[] with one word per segment; openai-whisper: segments[].words[]. */
const fromWhisper = (json) => {
  if (Array.isArray(json.transcription))
    return json.transcription.map((s) => ({ text: s.text, start: s.offsets.from / 1000, end: s.offsets.to / 1000 }));
  if (Array.isArray(json.segments))
    return json.segments.flatMap((s) => {
      if (!Array.isArray(s.words)) throw new Error("This transcript has no word timings: run whisper with --word_timestamps True.");
      return s.words.map((w) => ({ text: w.word, start: w.start, end: w.end }));
    });
  throw new Error("Not a whisper transcript: expected whisper.cpp's transcription[] or openai-whisper's segments[].");
};

/** Trims, drops empty and bracketed tokens ([MUSIC]), glues punctuation-only tokens to the word before. */
const tidy = (words) => {
  const out = [];
  for (const w of words) {
    const text = w.text.trim();
    if (!text || /^\[.*\]$|^\(.*\)$/.test(text)) continue;
    const last = out[out.length - 1];
    if (last && /^[^\p{L}\p{N}]+$/u.test(text)) {
      last.text += text;
      last.end = Math.max(last.end, w.end);
    } else out.push({ text, start: w.start, end: w.end });
  }
  // Zero-length words still need a frame or two on screen: borrow from the gap after, never past the next word.
  for (const [i, w] of out.entries()) {
    const next = out[i + 1]?.start ?? w.start + 0.08;
    if (w.end - w.start < 0.08) w.end = Math.max(w.end, Math.min(w.start + 0.08, next));
  }
  return out;
};

const fromScript = (text, duration) => {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new Error(`${file} has no words.`);
  const weight = (t) => t.length + 3 + (/[.!?]$/.test(t) ? 6 : /[,;:—–]$/.test(t) ? 3 : 0);
  const total = tokens.reduce((a, t) => a + weight(t), 0);
  let t = 0;
  return tokens.map((token) => {
    const w = weight(token);
    const start = t;
    // A word's pause comes after it, off screen as a gap, so captions don't linger over silence.
    const spoken = ((token.length + 3) / total) * duration;
    t += (w / total) * duration;
    return { text: token, start, end: start + spoken };
  });
};

try {
  const raw = readFileSync(file, "utf8");
  let words;
  if (mode === "whisper") words = tidy(fromWhisper(JSON.parse(raw)));
  else {
    const duration = opt("--duration");
    if (!(duration > 0))
      throw new Error("script mode needs --duration <s>: the voiceover's length (ffprobe), or the reading time you want.");
    words = fromScript(raw, duration);
  }
  console.log(JSON.stringify(words.map((w) => ({ text: w.text, start: round(w.start + offset), end: round(w.end + offset) }))));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
