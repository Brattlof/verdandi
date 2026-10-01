import type { InteractionMode } from "@verdandi/contracts";

/** Stage 2 (DESIGN §8.4): cheap, local facts about a task that classifiers read. */
export type Signals = {
  /** Lowercased task text. */
  readonly text: string;
  readonly mode: InteractionMode;
  /** Paths and file names the text mentions. */
  readonly files: readonly string[];
  readonly stackTrace: boolean;
  /** "think hard" and the like ask for depth; "quick" and the like for speed. */
  readonly depth: "deep" | "quick" | undefined;
};

const FILE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|py|rs|go|java|kt|swift|rb|php|cs|c|h|cpp|hpp|css|scss|html|vue|svelte|sql|sh|ps1|yaml|yml|toml)$/;
/** Two slashes or a trailing one, so "and/or" and "async/await" aren't paths. */
const PATH = /^[\w.@~-]*\/([\w.@-]+\/)+[\w.@*-]*$/;
const STACK_TRACE = /\n\s*at \S.*:\d+|traceback \(most recent call last\)|panicked at|exception in thread/;
const DEEP = /\b(think (hard|harder|deeply|carefully)|ultrathink|thoroughly|in depth)\b/;
const QUICK = /\b(quick(ly)?|briefly|tl;?dr)\b/;

export const signals = (text: string, mode: InteractionMode): Signals => {
  const lower = text.toLowerCase();
  const files = [
    ...new Set(
      text
        .split(/[\s`'"()[\]<>,;]+/)
        // A line and column, then the sentence's punctuation: `src/a.ts:12:5.` is `src/a.ts`.
        .map((w) => w.replace(/(:\d+)*[.:!?]*$/, ""))
        .filter((w) => !w.includes("://") && (FILE_EXT.test(w) || PATH.test(w))),
    ),
  ];
  return {
    text: lower,
    mode,
    files,
    stackTrace: STACK_TRACE.test(lower),
    depth: DEEP.test(lower) ? "deep" : QUICK.test(lower) ? "quick" : undefined,
  };
};

export const describeSignals = (s: Signals) =>
  [
    `${s.mode} mode`,
    `${s.files.length} file reference${s.files.length === 1 ? "" : "s"}`,
    ...(s.stackTrace ? ["a stack trace"] : []),
    ...(s.depth ? [`asks for ${s.depth === "deep" ? "depth" : "speed"}`] : []),
  ].join(", ");
