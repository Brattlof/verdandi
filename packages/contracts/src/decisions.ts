import { Schema } from "effect";

// The decision layer's wire shape (DESIGN §9.8): a state plus typed questions in, typed answers with
// probabilities out, as TypeSafe's `/v1/systemone` has it, so one client can serve every backend.
// Persisted inside `decision.recorded` events: a published shape is never edited.

const questionFields = {
  /** The judgment, e.g. `routing.task-class`. Backends and the lab group decisions by it. */
  kind: Schema.String,
  /** The question in words, for backends that read it. */
  question: Schema.String,
  /** Below this confidence the answer is marked `lowConfidence`, and the caller takes its safe default. */
  minConfidence: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
};

/** `choice` picks one of `options`, `score` places the state on a 0..1 scale, `noul` answers yes or no as a probability. */
export const DecisionQuestion = Schema.Union([
  Schema.Struct({ type: Schema.Literal("choice"), ...questionFields, options: Schema.NonEmptyArray(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("score"), ...questionFields }),
  Schema.Struct({ type: Schema.Literal("noul"), ...questionFields }),
]);
export type DecisionQuestion = typeof DecisionQuestion.Type;

/** The text the questions are about. */
export const DecisionRequest = Schema.Struct({ state: Schema.String, questions: Schema.Array(DecisionQuestion) });
export type DecisionRequest = typeof DecisionRequest.Type;

const answerFields = {
  kind: Schema.String,
  /** 0..1: how sure the backend is of this answer. */
  confidence: Schema.Number,
  /** Confidence fell below the question's minimum and no later backend did better: take the safe default. */
  lowConfidence: Schema.Boolean,
  /** The backend that answered, e.g. `rules`. */
  backend: Schema.String,
  /** What the backend saw, for traces; decision models leave it out. */
  why: Schema.optionalKey(Schema.String),
};

export const DecisionAnswer = Schema.Union([
  /** Options the backend gives no weight may be left out of `probabilities`. */
  Schema.Struct({
    type: Schema.Literal("choice"),
    ...answerFields,
    answer: Schema.String,
    probabilities: Schema.Record(Schema.String, Schema.Number),
  }),
  Schema.Struct({ type: Schema.Literal("score"), ...answerFields, score: Schema.Number }),
  /** `probability` is the chance the answer is yes. */
  Schema.Struct({ type: Schema.Literal("noul"), ...answerFields, probability: Schema.Number }),
]);
export type DecisionAnswer = typeof DecisionAnswer.Type;

/** One answer per question, in question order. */
export const DecisionResponse = Schema.Struct({ answers: Schema.Array(DecisionAnswer) });
export type DecisionResponse = typeof DecisionResponse.Type;

/** The judgments Verdandi asks for (DESIGN §9.8). Logged decisions are grouped by them, so a kind is never renamed. */
export const decisionKinds = {
  /** choice: the task's class (§8.5). */
  taskClass: "routing.task-class",
  /** score: how hard the task is. */
  difficulty: "routing.difficulty",
  /** noul: is this follow-up correcting the agent? Feeds a task's `implicitSatisfaction` (§8.8). */
  correcting: "follow-up.correcting",
  /** noul: does this untrusted text hold instructions aimed at an agent, or a way to send data out? (§17) */
  injection: "untrusted.injection",
} as const;

/**
 * The decision layer says a follow-up pushes back on the agent (DESIGN §8.7, §8.8). An unsure answer takes the safe
 * default: it doesn't.
 */
export const isCorrection = (a: DecisionAnswer) =>
  a.type === "noul" && a.kind === decisionKinds.correcting && !a.lowConfidence && a.probability >= 0.5;
