import { expect, test } from "bun:test";
import { type DecisionQuestion, decisionKinds } from "@verdandi/contracts";
import { Effect } from "effect";
import { type Backend, makeDecide } from "./decide.ts";
import { correctingQuestion } from "./questions.ts";
import { followUpRules, rulesBackend } from "./rules.ts";

const yesNo = (minConfidence: number): DecisionQuestion => ({ type: "noul", kind: "test.yes", question: "Yes?", minConfidence });
/** Answers every question yes with `confidence`. */
const sure = (id: string, confidence: number): Backend => ({
  id,
  answer: ({ questions }) => Effect.succeed(questions.map((q) => ({ type: "noul", kind: q.kind, probability: 0.9, confidence }))),
});

test("an answer below the question's minimum is marked low confidence and moves on to the next backend", async () => {
  const decide = makeDecide([sure("cheap", 0.4), sure("strong", 0.9)]);
  const { answers } = await Effect.runPromise(decide.decide({ state: "x", questions: [yesNo(0.3), yesNo(0.6)] }));
  expect(answers.map((a) => [a.backend, a.lowConfidence])).toEqual([
    ["cheap", false],
    ["strong", false],
  ]);
});

test("with no surer backend left, the surest answer stays, marked low confidence", async () => {
  const decide = makeDecide([sure("a", 0.5), sure("b", 0.2)]);
  const { answers } = await Effect.runPromise(decide.decide({ state: "x", questions: [yesNo(0.6)] }));
  expect(answers).toEqual([{ type: "noul", kind: "test.yes", probability: 0.9, confidence: 0.5, lowConfidence: true, backend: "a" }]);
});

test("a question no backend answers is a bug that names its kind", async () => {
  const exit = await Effect.runPromiseExit(makeDecide([rulesBackend({})]).decide({ state: "x", questions: [yesNo(0)] }));
  expect(String(exit)).toContain("No decision backend answers test.yes");
});

test("the follow-up rules tell pushback from the next step, and a hedge stays unsure", async () => {
  const decide = makeDecide([rulesBackend(followUpRules)]);
  const ask = async (text: string) => {
    const [a] = (await Effect.runPromise(decide.decide({ state: text, questions: [correctingQuestion] }))).answers;
    return a?.type === "noul" && a.kind === decisionKinds.correcting ? { yes: a.probability >= 0.5, low: a.lowConfidence } : undefined;
  };
  expect(await ask("No, that's not what I asked for")).toEqual({ yes: true, low: false });
  expect(await ask("The test still fails after your change")).toEqual({ yes: true, low: false });
  expect(await ask("Great, now add tests for the parser")).toEqual({ yes: false, low: false });
  expect(await ask("Actually, also update the README")).toEqual({ yes: true, low: true });
});
