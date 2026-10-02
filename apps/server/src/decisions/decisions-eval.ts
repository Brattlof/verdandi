import { atPin, type DecisionAnswer, type DecisionQuestion, decisionKinds, type TaskOutcome } from "@verdandi/contracts";
import type { Answered, Backend } from "@verdandi/decisions";
import { Effect } from "effect";
import { openReadOnly } from "../routing/replay.ts";

/** One logged answer (DESIGN §9.8), with the text it was about and whether the task it's about went well (null: not known). */
export type LoggedDecision = {
  readonly seq: number;
  readonly kind: string;
  readonly state: string;
  readonly question: DecisionQuestion;
  readonly answer: DecisionAnswer;
  readonly good: boolean | null;
};

/** Kinds asked about the task already running, not the one their turn starts. */
const aboutRunningTask = new Set<string>([decisionKinds.correcting]);

/** A task went well when its last turn completed and nobody stepped in: no override, no escalation, no thumbs down. */
const wentWell = (o: TaskOutcome) => o.status === "completed" && !o.userOverride && o.escalations === 0 && o.rating !== -1;

/** Every logged decision in the home's database, oldest first. Reads it read-only. */
export const loadLoggedDecisions = (home: string): LoggedDecision[] => {
  const db = openReadOnly(home);
  try {
    const rows = db
      .query<{ seq: number; kind: string; question: string; answer: string; text: string; own: string | null; running: string | null }, []>(
        `select d.seq, d.kind, d.question, d.answer, t.text,
           (select payload from task_outcomes where task_id = d.turn_id) as own,
           (select o.payload from tasks k join task_outcomes o on o.task_id = k.id
            where k.thread_id = d.thread_id and k.seq < d.seq order by k.seq desc limit 1) as running
         from decisions d join turns t on t.id = d.turn_id
         order by d.seq, d.idx`,
      )
      .all();
    return rows.map((r) => {
      const outcome = aboutRunningTask.has(r.kind) ? r.running : r.own;
      return {
        seq: r.seq,
        kind: r.kind,
        // The decision layer read the turn's text without a leading `@name` pin.
        state: atPin(r.text)?.text ?? r.text,
        question: JSON.parse(r.question) as DecisionQuestion,
        answer: JSON.parse(r.answer) as DecisionAnswer,
        good: outcome === null ? null : wentWell(JSON.parse(outcome) as TaskOutcome),
      };
    });
  } finally {
    db.close();
  }
};

/**
 * Each kind's answer read as the chance its task goes well, so it can be scored against the outcome. Proxies: a
 * surer class means a better-fitting route, a harder task fails more, and a correction means the last answer missed.
 */
const goodChance: Record<string, (a: Answered) => number | undefined> = {
  [decisionKinds.taskClass]: (a) => a.confidence,
  [decisionKinds.difficulty]: (a) => (a.type === "score" ? 1 - a.score : undefined),
  [decisionKinds.correcting]: (a) => (a.type === "noul" ? 1 - a.probability : undefined),
};

/** Same class, scores within 0.1, or the same side of 0.5. */
const agrees = (a: Answered, b: Answered) =>
  a.type === "choice" && b.type === "choice"
    ? a.answer === b.answer
    : a.type === "score" && b.type === "score"
      ? Math.abs(a.score - b.score) <= 0.1
      : a.type === "noul" && b.type === "noul" && a.probability >= 0.5 === b.probability >= 0.5;

const mean = <T>(xs: readonly T[], f: (x: T) => number) => (xs.length === 0 ? null : xs.reduce((s, x) => s + f(x), 0) / xs.length);

export type BackendStats = {
  readonly id: string;
  readonly answered: number;
  /** Share of its answers that agree with the logged one. */
  readonly agreement: number | null;
  /** Share of its answers below the question's minimum confidence. */
  readonly lowConfidence: number | null;
  /** Over decisions with a known outcome: whether its chance of going well was on the right side of 0.5, its Brier score, and the chance's mean. */
  readonly accuracy: number | null;
  readonly brier: number | null;
  readonly meanChance: number | null;
};

export type KindReport = {
  readonly kind: string;
  readonly decisions: number;
  /** How many have a known outcome, and the share of those that went well. */
  readonly known: number;
  readonly good: number | null;
  readonly backends: readonly BackendStats[];
};

const stats = (id: string, kind: string, rows: readonly { d: LoggedDecision; a: Answered | undefined }[]): BackendStats => {
  const answered = rows.flatMap(({ d, a }) => (a ? [{ d, a }] : []));
  const scored = answered.flatMap(({ d, a }) => {
    const p = goodChance[kind]?.(a);
    return d.good === null || p === undefined ? [] : [{ p, good: d.good ? 1 : 0 }];
  });
  return {
    id,
    answered: answered.length,
    agreement: mean(answered, ({ d, a }) => (agrees(d.answer, a) ? 1 : 0)),
    lowConfidence: mean(answered, ({ d, a }) => (a.confidence < d.question.minConfidence ? 1 : 0)),
    accuracy: mean(scored, (s) => ((s.p >= 0.5 ? 1 : 0) === s.good ? 1 : 0)),
    brier: mean(scored, (s) => (s.p - s.good) ** 2),
    meanChance: mean(scored, (s) => s.p),
  };
};

/** Replays `logged` through `candidate`, asking each turn's questions together as `Decide` did, and scores both per kind. */
export const evaluate = (logged: readonly LoggedDecision[], candidate: Backend) =>
  Effect.gen(function* () {
    const answers = new Map<LoggedDecision, Answered | undefined>();
    for (const group of Map.groupBy(logged, (d) => d.seq).values()) {
      const got = yield* candidate.answer({ state: group[0]?.state ?? "", questions: group.map((d) => d.question) });
      for (const [i, d] of group.entries()) answers.set(d, got[i]);
    }
    return [...Map.groupBy(logged, (d) => d.kind)].map(([kind, ds]): KindReport => {
      const known = ds.filter((d) => d.good !== null);
      const backends = [...new Set(ds.map((d) => d.answer.backend))].join(", ");
      return {
        kind,
        decisions: ds.length,
        known: known.length,
        good: mean(known, (d) => (d.good ? 1 : 0)),
        backends: [
          stats(
            `logged (${backends})`,
            kind,
            ds.map((d) => ({ d, a: d.answer })),
          ),
          stats(
            candidate.id,
            kind,
            ds.map((d) => ({ d, a: answers.get(d) })),
          ),
        ],
      };
    });
  });
