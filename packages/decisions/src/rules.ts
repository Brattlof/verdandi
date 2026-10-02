import { type DecisionQuestion, decisionKinds, type TaskClass } from "@verdandi/contracts";
import { Effect } from "effect";
import type { Answered, Backend } from "./decide.ts";

/** Answers one kind of question about `state`, or undefined when it can't. */
export type Rule = (state: string, question: DecisionQuestion) => Answered | undefined;

/** The `rules` backend: free and deterministic, the default for every kind of question (ADR 0009). */
export const rulesBackend = (rules: Readonly<Record<string, Rule>>): Backend => ({
  id: "rules",
  answer: ({ state, questions }) => Effect.sync(() => questions.map((q) => rules[q.kind]?.(state, q))),
});

/** A task classification, as the router's own `rules` classifier makes one. */
export type TaskClassification = {
  readonly taskClass: TaskClass;
  readonly difficulty: number;
  readonly confidence: number;
  readonly why: string;
};

/**
 * Rules for routing classification (DESIGN §8.4) from a classifier over the task's text. Passed in, so
 * this package needn't depend on the router; verdandid passes the router's keyword rules.
 */
export const routingRules = (classify: (text: string) => TaskClassification): Record<string, Rule> => ({
  [decisionKinds.taskClass]: (state) => {
    const c = classify(state);
    return {
      type: "choice",
      kind: decisionKinds.taskClass,
      answer: c.taskClass,
      probabilities: { [c.taskClass]: c.confidence },
      confidence: c.confidence,
      why: c.why,
    };
  },
  // The keyword rules derive difficulty from the class, so it is exactly as sure as the class is.
  [decisionKinds.difficulty]: (state) => {
    const c = classify(state);
    return { type: "score", kind: decisionKinds.difficulty, score: c.difficulty, confidence: c.confidence, why: `a ${c.taskClass} task` };
  },
});

/** Phrases that push back on what the agent did. A polite "no problem" or "no worries" doesn't. */
const CORRECTING =
  /^(no(?!\s+(problem|worries|rush)\b)|nope|wrong|stop|undo)\b|\b(that'?s (wrong|not (it|right|correct|what i (asked|meant|wanted)))|not what i (asked|meant|wanted)|you (broke|missed|forgot|misunderstood|ignored|deleted|removed)|(still|it) (doesn'?t|does not|isn'?t|is not|won'?t) (work|compile|build|pass)|(didn'?t|did not|doesn'?t|does not) (work|fix|help)|still (fails|failing|broken|wrong|there|happening|crashes|crashing)|try again|revert (that|this|it|your)|roll (it|that|this) back|wrong (file|approach|place|answer|function|thing)|i (said|told you)|why did you)\b/;
/** Hints that could be a correction or just the next step, e.g. "actually, also add tests". */
const HEDGING = /^(but|hmm|actually)\b|\b(instead|rather)\b/;

/** Rules for "is this follow-up correcting the agent?" (DESIGN §8.8): a hedge is too unsure to count. */
export const followUpRules: Record<string, Rule> = {
  [decisionKinds.correcting]: (state) => {
    const text = state.trim().toLowerCase();
    const strong = text.match(CORRECTING)?.[0];
    const hedge = strong === undefined ? text.match(HEDGING)?.[0] : undefined;
    const [probability, confidence, why] =
      strong !== undefined
        ? [0.85, 0.8, `"${strong}" pushes back`]
        : hedge !== undefined
          ? [0.6, 0.4, `"${hedge}" may or may not push back`]
          : [0.1, 0.7, "no pushback phrase"];
    return { type: "noul", kind: decisionKinds.correcting, probability, confidence, why };
  },
};

// ponytail: pattern rules only, so a reworded instruction gets through. Upgrade: a decision model on this kind once
// one beats the rules on logged decisions (ADR 0009).
const INSTRUCTIONS = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the)\b[^.\n]{0,20}\b(instructions?|rules|prompts?|guidelines)\b/i,
  /\byou are now\b|\bfrom now on,? you (are|must|will)\b|\bnew instructions\b/i,
  /<\/?\s*(system|assistant|user|instructions?)\s*>|\[\/?INST\]|^\s*(system|assistant)\s*:/im,
];
const EXFILTRATION = [
  /\b(curl|wget|Invoke-WebRequest|iwr|nc|ncat)\b[^\n]*\bhttps?:\/\//i,
  /!\[[^\]]*\]\(\s*https?:\/\//i, // a remote image would fetch on render
  /\b(send|post|upload|forward|exfiltrate|leak)\b[^.\n]{0,60}\b(to|at)\b[^.\n]{0,20}(https?:\/\/|\b[\w.-]+\.(com|net|org|io|xyz|ru)\b|@[\w-]+\.)/i,
  /https?:\/\/\S+[?&][\w-]*(token|key|secret|data|payload|q)=/i,
];

/** The line around `index` in `text`, cut to about 100 characters. */
const around = (text: string, index: number) => {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  const line = text.slice(start, end === -1 ? undefined : end).trim();
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
};

/**
 * Rules for "does this text hold instructions aimed at an AI, or a way to send data out?" (DESIGN §17): one
 * pattern set for memory saves and for everything Verdandi hands the agent. `why` quotes the line that matched.
 */
export const injectionRules: Record<string, Rule> = {
  [decisionKinds.injection]: (state) => {
    const hit = (patterns: readonly RegExp[]) => patterns.map((p) => p.exec(state)).find((m) => m !== null);
    const instruction = hit(INSTRUCTIONS);
    const exfiltration = instruction ? undefined : hit(EXFILTRATION);
    const match = instruction ?? exfiltration;
    if (!match) return { type: "noul", kind: decisionKinds.injection, probability: 0.1, confidence: 0.7, why: "no injection pattern" };
    const what = instruction ? "reads like instructions to an agent" : "reads like a way to send data out";
    return {
      type: "noul",
      kind: decisionKinds.injection,
      probability: 0.9,
      confidence: 0.8,
      why: `${what}: "${around(state, match.index)}"`,
    };
  },
};
