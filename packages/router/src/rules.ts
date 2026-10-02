import type { TaskClass } from "@verdandi/contracts";
import type { Signals } from "./signals.ts";

export type Classification = {
  readonly taskClass: TaskClass;
  /** 0..1; recorded for learning, not acted on yet. */
  readonly difficulty: number;
  /** 0..1; below the policy's `minConfidence` the router falls back to the budget mode's safe default. */
  readonly confidence: number;
  /** Set by the decision layer, which checks confidence itself (DESIGN §9.8); it then decides the fallback instead. */
  readonly lowConfidence?: boolean;
  /** What the classifier saw, for the trace. */
  readonly why: string;
};

/** Stage 3 (DESIGN §8.4). Passed into the router from outside, so other classifiers can replace `rules`. */
export type Classifier = (signals: Signals) => Classification;

/** Intent phrases per class, worth `points` for each distinct phrase found. Ties go to the class listed first. */
const RULES: ReadonlyArray<readonly [TaskClass, number, RegExp]> = [
  ["chat.general", 2, /^(hi|hello|hey|thanks|thank you|good (morning|afternoon|evening)|how are you)\b/g],
  ["ask.search", 2, /\b(where (is|are|do|does)|which files?|find (the|all|every|where)|locate)\b/g],
  // Generic question words: they win only when nothing more specific matches.
  ["ask.explain", 1, /\b(what (does|is|are)|how (does|do|is)|explain|walk me through)\b/g],
  [
    "chore.git",
    2,
    /\b(commit message|commit (this|these|that|the|my|it)|pr description|pull request description|rebase|cherry-pick|squash)\b/g,
  ],
  ["docs.write", 2, /\b(readme|changelog|documentation|docs|docstrings?|jsdoc|release notes)\b/g],
  ["code.edit.mechanical", 2, /\b(rename|move|extract|reformat|sort imports|update (the )?imports|bump|boilerplate|crud)\b/g],
  // "refactor" alone could be one function or the whole repo, so it hints both ways and stays unsure.
  ["code.edit.mechanical", 1, /\brefactor/g],
  ["code.refactor.large", 1, /\brefactor/g],
  [
    "code.refactor.large",
    2,
    /\b(migrate|restructure|re-?architect|(across|throughout) the (codebase|repo|project)|(the )?(whole|entire) (codebase|repo|project|app)|everywhere|every (file|module|package))\b/g,
  ],
  ["code.edit.local", 2, /\b(fix|typo|tweak|adjust|off-by-one)\b/g],
  ["test.write", 2, /\b((add|write|more|missing) (unit |integration |e2e )?tests?|test coverage|test cases?)\b/g],
  [
    "code.feature",
    2,
    /\b(implement|add (a |an )?(new )?(feature|command|endpoint|page|screen|option|flag|setting)|add support|build (a|an))\b/g,
  ],
  [
    "debug.investigate",
    2,
    /\b(debug|root cause|why .*(fail|crash|broken|error|hang|slow)|flaky|intermittent|investigate|regression|memory leak)/g,
  ],
  ["review", 2, /\b(review|audit|look over)\b/g],
  ["design.architecture", 2, /\b(design|architecture|trade-?offs?|should (we|i) use|pros and cons)\b/g],
];

const BASE_DIFFICULTY: Record<TaskClass, number> = {
  "chat.general": 0.05,
  "ask.search": 0.1,
  "chore.git": 0.1,
  "ask.explain": 0.2,
  "docs.write": 0.2,
  "code.edit.mechanical": 0.2,
  "code.edit.local": 0.4,
  "test.write": 0.4,
  review: 0.5,
  "code.feature": 0.6,
  "debug.investigate": 0.7,
  "code.refactor.large": 0.8,
  "design.architecture": 0.8,
  // Never classified from a user's text: Verdandi starts its own reviews in this class.
  "aux.review": 0.1,
};

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The default classifier: free, deterministic keyword rules over the v1 taxonomy.
 * ponytail: English keyword rules; upgrade to the decision layer (§9.8) once logged decisions show it beats them (ADR 0009).
 */
export const rules: Classifier = (s) => {
  const scores = new Map<TaskClass, number>();
  const seen: string[] = [];
  const add = (cls: TaskClass, points: number, what: string) => {
    scores.set(cls, (scores.get(cls) ?? 0) + points);
    seen.push(`${what} → ${cls}`);
  };
  for (const [cls, points, re] of RULES) {
    for (const phrase of new Set(Array.from(s.text.matchAll(re), (m) => m[0]))) add(cls, points, `"${phrase}"`);
  }
  // Signals blank file names out of the text, but a README or changelog is the docs it names.
  if (s.files.some((f) => /(^|\/)(readme|changelog)\.\w+$/i.test(f))) add("docs.write", 2, "a readme or changelog");
  if (s.stackTrace) add("debug.investigate", 2, "stack trace");
  if (s.files.length >= 4) add("code.refactor.large", 1, `${s.files.length} files`);
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  const [taskClass, best] = ranked[0] ?? ["chat.general", 0];
  const second = ranked[1]?.[1] ?? 0;
  const depth = s.depth === "deep" ? 0.15 : s.depth === "quick" ? -0.15 : 0;
  return {
    taskClass,
    difficulty: clamp(BASE_DIFFICULTY[taskClass] + depth + (s.stackTrace ? 0.1 : 0) + Math.min(s.files.length, 10) * 0.02),
    // The margin over the runner-up: one clear cue gives 0.67–0.75, a tie or no cue stays at or under 0.5.
    confidence: 1 - (second + 1) / (best + 2),
    why: seen.join(", ") || "no rule matched",
  };
};
