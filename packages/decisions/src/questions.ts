import { type DecisionAnswer, type DecisionQuestion, decisionKinds, TaskClass } from "@verdandi/contracts";
import { Schema } from "effect";
import type { TaskClassification } from "./rules.ts";

/**
 * Routing classification (DESIGN §8.4): the task's class and difficulty. `minConfidence` is the routing
 * policy's, so a low-confidence class is exactly one the router must not act on.
 */
export const routingQuestions = (minConfidence: number): DecisionQuestion[] => [
  {
    type: "choice",
    kind: decisionKinds.taskClass,
    question: "What kind of task is this?",
    options: TaskClass.literals,
    minConfidence,
  },
  {
    type: "score",
    kind: decisionKinds.difficulty,
    question: "How hard is this task, from 0 (trivial) to 1 (the hardest)?",
    minConfidence: 0,
  },
];

/** Asked of a thread's later turns: does the user push back on the agent's last answer? */
export const correctingQuestion: DecisionQuestion = {
  type: "noul",
  kind: decisionKinds.correcting,
  question: "Is this follow-up correcting the agent?",
  minConfidence: 0.6,
};

const isTaskClass = Schema.is(TaskClass);

/**
 * The routing classification in `answers`, or undefined when they hold none. A class outside the
 * taxonomy counts as no confidence at all, so the router takes its safe default.
 */
export const classificationOf = (
  answers: readonly DecisionAnswer[],
): (TaskClassification & { readonly lowConfidence: boolean }) | undefined => {
  const choice = answers.find((a) => a.kind === decisionKinds.taskClass);
  if (choice?.type !== "choice") return undefined;
  const score = answers.find((a) => a.kind === decisionKinds.difficulty);
  const known = isTaskClass(choice.answer);
  return {
    taskClass: known ? choice.answer : "chat.general",
    difficulty: score?.type === "score" ? score.score : 0,
    confidence: known ? choice.confidence : 0,
    lowConfidence: !known || choice.lowConfidence,
    why: `${choice.backend}: ${known ? (choice.why ?? "no explanation") : `"${choice.answer}" isn't a task class`}`,
  };
};
