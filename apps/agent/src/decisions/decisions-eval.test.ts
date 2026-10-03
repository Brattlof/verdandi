import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Command, type CommandId, decisionKinds, type ThreadId, type TurnId } from "@verdandi/contracts";
import type { Backend } from "@verdandi/decisions";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { Reactor } from "../event-store/reactor.ts";
import { evaluate, type LoggedDecision, loadLoggedDecisions } from "./decisions-eval.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempHome(d);
});
const tempDir = () => {
  const d = makeTempHome();
  dirs.push(d);
  return d;
};

test("logged decisions come back with their turn's text and how the task they're about went", async () => {
  const home = tempDir();
  const projectPath = tempDir();
  mkdirSync(join(projectPath, ".verdandi"));
  writeFileSync(
    join(projectPath, ".verdandi", "routing.yaml"),
    "targets:\n  small: { harness: fake, provider: fake, model: fake-small }\nfallback: { prefer: [small] }\n",
  );
  const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness() }));
  const dispatch = (c: Command) => Effect.flatMap(Engine, (engine) => engine.dispatch(c));
  const thread = (...texts: string[]) =>
    Effect.gen(function* () {
      const threadId = crypto.randomUUID() as ThreadId;
      yield* dispatch({ type: "thread.create", commandId: crypto.randomUUID() as CommandId, threadId, projectPath });
      for (const text of texts) {
        const turnId = crypto.randomUUID() as TurnId;
        yield* dispatch({ type: "turn.send", commandId: crypto.randomUUID() as CommandId, threadId, turnId, text, mode: "build" });
        yield* (yield* Reactor).drain;
      }
    });
  // A follow-up's correction is about the task already running; a failed task didn't go well.
  await runtime.runPromise(Effect.andThen(thread("@fake-small Where is the auth middleware?", "No, that's wrong"), thread("fail")));
  await runtime.dispose();

  expect(loadLoggedDecisions(home).map((d) => [d.kind, d.state, d.good, d.answer.backend])).toEqual([
    [decisionKinds.taskClass, "Where is the auth middleware?", true, "rules"],
    [decisionKinds.difficulty, "Where is the auth middleware?", true, "rules"],
    [decisionKinds.correcting, "No, that's wrong", true, "rules"],
    [decisionKinds.taskClass, "fail", false, "rules"],
    [decisionKinds.difficulty, "fail", false, "rules"],
  ]);
});

const classQuestion = { type: "choice", kind: decisionKinds.taskClass, question: "?", options: ["a", "b"], minConfidence: 0.5 } as const;
const logged = (seq: number, state: string, answer: string, confidence: number, good: boolean | null): LoggedDecision => ({
  seq,
  kind: decisionKinds.taskClass,
  state,
  question: classQuestion,
  answer: { type: "choice", kind: decisionKinds.taskClass, answer, probabilities: {}, confidence, lowConfidence: false, backend: "rules" },
  good,
});
/** Answers `b` for every state but "x", and is never sure. */
const candidate: Backend = {
  id: "candidate",
  answer: ({ state, questions }) =>
    Effect.succeed(
      questions.map(
        (q) => ({ type: "choice", kind: q.kind, answer: state === "x" ? "a" : "b", probabilities: {}, confidence: 0.25 }) as const,
      ),
    ),
};

test("a candidate is measured against the logged answers, and against the outcome where it's known", async () => {
  const [report] = await Effect.runPromise(
    evaluate([logged(1, "x", "a", 0.75, true), logged(2, "y", "a", 0.75, false), logged(3, "z", "a", 0.75, null)], candidate),
  );
  expect(report).toEqual({
    kind: decisionKinds.taskClass,
    decisions: 3,
    known: 2,
    good: 0.5,
    backends: [
      {
        id: "logged (rules)",
        answered: 3,
        agreement: 1,
        lowConfidence: 0,
        accuracy: 0.5,
        brier: (0.25 ** 2 + 0.75 ** 2) / 2,
        meanChance: 0.75,
      },
      {
        id: "candidate",
        answered: 3,
        agreement: 1 / 3,
        lowConfidence: 1,
        accuracy: 0.5,
        brier: (0.75 ** 2 + 0.25 ** 2) / 2,
        meanChance: 0.25,
      },
    ],
  });
});
