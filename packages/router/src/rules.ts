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

/** What a feature request asks to add: "add a `--since` flag", "a new subcommand". */
const FEATURE_NOUNS =
  "feature|command|subcommand|tool|endpoint|page|screen|option|flag|setting|button|field|column|limit|mode|view|tab|shortcut|filter|toggle|menu|dialog|panel|action|output|hook|event";

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
  // With a symptom and no file named, "fix" asks to find the bug first, so it counts for debug.investigate (see `rules`).
  ["code.edit.local", 2, /\b(fix|typo|tweak|adjust|off-by-one)\b/g],
  // Writing or extending tests, unless the tests are only to pass: "add the flag and make the tests pass".
  [
    "test.write",
    2,
    /\b(add|write|extend|expand|strengthen|improve|more|missing|new) ((?!tests?\b)[^\s.;:!?]+ ){0,3}?tests?\b(?! (pass|fail|run|still|break))/g,
  ],
  [
    "test.write",
    2,
    /\b(tests? (for|covering|that (cover|check|catch|kill|exercise))|cover \S+( \S+){0,3}? with tests|test (coverage|cases?|suite)|coverage|untested|mutants?)\b/g,
  ],
  // New behaviour: a thing to add, something users can't do yet, or a request for it.
  [
    "code.feature",
    2,
    /\b(implement|add support|support for|^support|build (a|an)|make it possible|be able to|(there'?s|there is) no way to)\b/g,
  ],
  ["code.feature", 2, new RegExp(String.raw`\badd (an? |the )?(new )?((?!tests?\b)[^\s.;:!?]+ ){0,3}?(${FEATURE_NOUNS})s?\b`, "g")],
  ["code.feature", 2, new RegExp(String.raw`\bnew (\S+ ){0,2}?(${FEATURE_NOUNS})s?\b`, "g")],
  ["code.feature", 2, /\b(let|allow|enable) (the |a )?(users?|me(?! know)|you|people|agents?|clients?|callers?)\b/g],
  [
    "code.feature",
    2,
    /\b(i'?d like|i want|we need|i need|would be (nice|great|useful) to have|can we (get|have)) (a way|the ability|support|to be able|an?(?= (?!(\S+ )?tests?\b)))/g,
  ],
  [
    "debug.investigate",
    2,
    /\b(debug|root cause|why .*(fail|crash|broken|error|hang|slow)|flaky|intermittent|investigate|regression(?! tests?)|memory leak)/g,
  ],
  ["review", 2, /\b(review|audit|look over)\b/g],
  ["design.architecture", 2, /\b(design|architecture|trade-?offs?|should (we|i) use|pros and cons)\b/g],
];

const SYMPTOM_VERBS =
  "work|show|appear|load|save|update|render|fire|run|start|finish|end|stop|close|clear|reset|respond|refresh|persist|apply|match|count|trigger|change|pass|compile|print|log|send|return|list|open|sync";

/**
 * How a bug report gives its symptom, what goes wrong and when: each distinct phrase is worth 2 points to
 * debug.investigate, but only when the text names no file, since a bug whose file is named is a local edit.
 */
const SYMPTOMS: readonly RegExp[] = [
  /\b(crash(es|ed|ing)?|hangs|freezes|throws|panics|leaks|leaking|sometimes|randomly|every other time|even though)\b/g,
  /\b\w+(s|ed) (the |an? )?(wrong|incorrect|stale|duplicated?)\b/g,
  /\breturns? (empty|undefined|null|nothing|nan)\b/g,
  /\b(shows|displays|lists|says|prints|reports|keeps|stays|comes back)\b[^.;:!?]{0,60}?\b(after|again|twice|instead of)\b/g,
  /\bstill (shows|says|lists|runs|running|appears|returns|fails|failing|busy|pending|there)\b/g,
  // "it does not save", but not a spec's "do not change the API".
  new RegExp(
    String.raw`\b(doesn'?t|didn'?t|won'?t|isn'?t|aren'?t|(?<!(do|must|should|shall) )not|no longer|never|stopped|fails to|failed to) (\w+ )?(${SYMPTOM_VERBS})\w*`,
    "g",
  ),
  /\b(is|are|was|were|gets?|got|comes out) (wrong|incorrect|broken|missing|stale|lost|duplicated|ignored|off by one)\b/g,
  /\b(expected|should (be|show|say|return|list)) [^;!?\n]{0,80}?\b(but|got|instead)\b/g,
  /\b(gives|gets|got|raises|hits|returns|logs|shows|throws) (an? |the )?(\w+ )?(error|exception|500|404)s?\b/g,
];

const distinct = (text: string, re: RegExp) => new Set(Array.from(text.matchAll(re), (m) => m[0]));

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
  // Never classified from a user's text: Verdandi starts its own reviews and handoffs in these classes.
  "aux.review": 0.1,
  "aux.handoff": 0.1,
};

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The default classifier: free, deterministic keyword rules over the v1 taxonomy.
 * ponytail: English keyword rules; upgrade to the decision layer (§9.8) once logged decisions show it beats them (ADR 0009).
 */
export const rules: Classifier = (s) => {
  const scores = new Map<TaskClass, number>();
  const cues = new Map<TaskClass, string[]>();
  const add = (cls: TaskClass, points: number, what: string) => {
    scores.set(cls, (scores.get(cls) ?? 0) + points);
    cues.set(cls, [...(cues.get(cls) ?? []), what]);
  };
  const symptoms = s.files.length === 0 ? [...new Set(SYMPTOMS.flatMap((re) => [...distinct(s.text, re)]))] : [];
  for (const [cls, points, re] of RULES) {
    for (const phrase of distinct(s.text, re)) {
      if (cls === "code.edit.local" && phrase === "fix" && symptoms.length > 0)
        add("debug.investigate", points, `"fix" with no file named`);
      else add(cls, points, `"${phrase}"`);
    }
  }
  for (const phrase of symptoms) add("debug.investigate", 2, `"${phrase}"`);
  // Signals blank file names out of the text, but a README or changelog is the docs it names.
  if (s.files.some((f) => /(^|\/)(readme|changelog)\.\w+$/i.test(f))) add("docs.write", 2, "a readme or changelog");
  if (s.stackTrace) add("debug.investigate", 2, "a stack trace");
  if (s.files.length >= 4) add("code.refactor.large", 1, `${s.files.length} files`);
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  const [taskClass, best] = ranked[0] ?? ["chat.general", 0];
  const second = ranked[1]?.[1] ?? 0;
  const read = (cls: TaskClass) => cues.get(cls)?.join(", ");
  const depth = s.depth === "deep" ? 0.15 : s.depth === "quick" ? -0.15 : 0;
  return {
    taskClass,
    difficulty: clamp(BASE_DIFFICULTY[taskClass] + depth + (s.stackTrace ? 0.1 : 0) + Math.min(s.files.length, 10) * 0.02),
    // The margin over the runner-up: one clear cue gives 0.67–0.75, a tie or no cue stays at or under 0.5.
    confidence: 1 - (second + 1) / (best + 2),
    // The winner's cues, then each runner-up's: the router's reason quotes it.
    why: ranked.map(([cls], i) => (i === 0 ? read(cls) : `${read(cls)} for ${cls}`)).join("; ") || "no rule matched",
  };
};
