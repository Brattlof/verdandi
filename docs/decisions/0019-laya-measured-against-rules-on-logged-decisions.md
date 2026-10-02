# 0019 · Laya measured against rules on logged decisions

## Status

Accepted (2026-10-02).

## Context

M2 logs every decision (`decision.recorded`, the `decisions` table) so a decision model can be measured against `rules` on real data (DESIGN §9.8, ADR 0009). Two things were open: nothing replayed those decisions through another backend, and "`laya-ts` under Bun" from the M0 list.

`verdandi decisions eval [--candidate <module>] [--home <dir>]` now does the replay. It opens the home's database read-only, asks each logged turn's questions of the candidate together, as `Decide` did, and prints per question kind:

- **agreement** with the logged answer: the same class, a score within 0.1, or a yes/no on the same side of 0.5;
- the share of answers **below the question's minimum confidence**;
- where the task's outcome is known, **accuracy and Brier score**. A task *went well* when its last turn completed with no route override, no escalation and no thumbs down. Each kind's answer is read as the chance its task went well: a class's confidence, 1 − difficulty, and 1 − P(correcting), where a correction is about the task already running.

The candidate is any module whose default export is a `Backend` from `@verdandi/decisions`, or a promise of one; the default is today's `rules`. A backend can be measured without becoming a dependency of the repo.

**Data.** There is no live Verdandi home on the development machine, so the only real logged decisions are the M2 eval set's batch homes (ADR 0017). They were copied to a temp folder, database and WAL, and measured there. The 7 runs hold 101 decisions per routing kind, all from `rules`. The `auto` run holds all 30 distinct prompts; the other runs repeat them. All 101 tasks completed, none was overridden or escalated, and no task had a follow-up turn, so there are no `follow-up.correcting` decisions.

**`laya-ts`.** No package by that name exists on npm. The closest is `@receptron/laya` 0.1.2 (MIT, published 2026-09-21), an ONNX Runtime port of Laya's reference `system_one` that downloads the English fp32 bundle (~1.6 GB) from Hugging Face. It was tried in the gitignored `spikes/`, outside the repo's `package.json`, as a `Backend` passed with `--candidate`. Classes were offered with their taxonomy descriptions, and difficulty as five levels.

Results on the `auto` run's copy (Bun 1.4.2, macOS arm64):

| Kind | Backend | Agrees with logged | Low confidence | Accuracy | Brier | Mean P(went well) |
|---|---|---|---|---|---|---|
| `routing.task-class` (n = 30) | `rules` replayed | 100% | 0% | 100% | 0.056 | 0.767 |
| | `laya` | 30% | 13% | 97% | 0.063 | 0.825 |
| `routing.difficulty` (n = 30) | `rules` replayed | 100% | 0% | 63% | 0.258 | 0.522 |
| | `laya` | 43% | 0% | 83% | 0.206 | 0.549 |

- `rules` replayed today agrees with every one of the 101 logged answers in all 7 copies: the rules haven't drifted since the decisions were made.
- Laya agreed with `rules` on 9 of 30 classes. It picked `code.refactor.large` for 11 tasks, 5 of them `rules`' `code.feature` and 3 `code.edit.local`, which would route them up to Opus at high effort.
- Laya runs under Bun 1.4.2 through `onnxruntime-node` 1.30: it loads in 6.3 s, holds 1.7 GB, and answers a routing request (two questions) in about 0.4 s while using about 3.5 cores.
- Since every task went well, accuracy and Brier only measure how high each backend rates the chance of success; they can't tell a right answer from a wrong one. The class question has no ground-truth labels in the database.

## Decision

1. `rules` stays the default backend for every question kind (ADR 0009). No kind has evidence for Laya: the outcomes can't separate the backends, and where they disagree Laya leans towards the most expensive class.
2. No `laya` backend joins the repo yet. It would add `onnxruntime-node` and a 1.6 GB model download, which needs the maintainers' sign-off, and `@receptron/laya` is younger than the 14-day minimum until 2026-10-05. A spike module through `--candidate` measures it in the meantime.
3. A decision backend earns a kind when `verdandi decisions eval` on a copy of a real home shows it beats `rules` there, with outcomes that include failed, overridden or corrected tasks.

## Consequences

- The eval needs a real home with failures and follow-ups before Laya can be judged. The batch homes are too uniform: every task completed in one turn.
- When a `laya` backend is added, it runs in a worker process (ADR 0009), and the `ponytail` note in the engine applies: decisions must be asked before the write transaction, since 0.4 s is no longer free.
- Labelling task classes by hand, or recording the user's class corrections, would let the eval report accuracy on the class question itself, not just the task's outcome.
