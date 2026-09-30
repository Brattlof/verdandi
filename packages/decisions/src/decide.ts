import type { DecisionAnswer, DecisionRequest, DecisionResponse } from "@verdandi/contracts";
import { Context, Effect } from "effect";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A backend's answer, before `Decide` checks it against the question's minimum confidence. */
export type Answered = DistributiveOmit<DecisionAnswer, "lowConfidence" | "backend">;

/** One way to answer questions, e.g. `rules`. Answers in question order; undefined where it can't answer one. */
export type Backend = {
  readonly id: string;
  readonly answer: (request: DecisionRequest) => Effect.Effect<ReadonlyArray<Answered | undefined>>;
};

/** The decision layer (DESIGN §9.8): typed answers with probabilities and confidence, for typed questions about a state. */
export class Decide extends Context.Service<Decide, { readonly decide: (request: DecisionRequest) => Effect.Effect<DecisionResponse> }>()(
  "verdandi/Decide",
) {}

/**
 * Asks `backends` in order, cheapest first. A question moves on to the next backend while its answer is
 * below the question's `minConfidence`; after the last it keeps the surest answer, marked `lowConfidence`,
 * and the caller takes its safe default. A question no backend answers is a bug: add a rule for its kind.
 */
export const makeDecide = (backends: readonly Backend[]): Decide["Service"] =>
  Decide.of({
    decide: ({ state, questions }) =>
      Effect.gen(function* () {
        const answers: (DecisionAnswer | undefined)[] = questions.map(() => undefined);
        for (const backend of backends) {
          const open = questions.flatMap((q, i) => (answers[i]?.lowConfidence === false ? [] : [{ q, i }]));
          if (open.length === 0) break;
          const got = yield* backend.answer({ state, questions: open.map(({ q }) => q) });
          open.forEach(({ q, i }, j) => {
            const a = got[j];
            const before = answers[i];
            if (!a || (before && before.confidence >= a.confidence)) return;
            answers[i] = { ...a, lowConfidence: a.confidence < q.minConfidence, backend: backend.id };
          });
        }
        return {
          answers: yield* Effect.forEach(questions, (q, i) => {
            const a = answers[i];
            return a ? Effect.succeed(a) : Effect.die(new Error(`No decision backend answers ${q.kind}. Add a rule for it.`));
          }),
        };
      }),
  });
