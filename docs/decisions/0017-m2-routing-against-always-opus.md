# 0017 · M2 routing measured against always-Opus

## Status

Accepted (2026-10-01).

## Context

M2's exit criterion (DESIGN §21, goal G1) is at least 30% lower cost per completed task than always Opus at default effort, with no drop in success rate. The spend dashboard's savings figure can't show that: it prices recorded tokens at Opus's list price and can't tell whether the cheaper route would have succeeded.

`verdandi batch` (DESIGN §8.10, #94) runs an eval set on several routes and grades each task by its verifier. The eval set for #78:

- **30 small, self-contained tasks on this repo,** pinned to a6f9915, each with a hidden test and a reference patch. A check confirms every test fails at the base commit and passes, with the repo typechecking, once the patch is applied.
- **They span the classes the router sees most:** `code.edit.local` 7, `code.feature` 7, `test.write` 6 (graded by killing mutants), `debug.investigate` 4, `code.edit.mechanical` 3, `docs.write` 2, `ask.explain` 1.
- **It lives outside the repo,** in the developer's `~/verdandi-evals/m2/`, so an agent working on Verdandi can't read the hidden tests. Its README says how to run it.

Every task ran once on each of three routes:

- `auto`, the router on the built-in balanced policy;
- baseline (a), `claude-code/opus/medium`;
- baseline (b), `claude-code/sonnet/high`.

All runs used Claude Code on a subscription, with requests approved and a 20-minute limit per task. Costs are what Claude Code reports at API prices; no metered dollars were spent. The first 10 tasks ran before #111 and #113 changed the classifier. `auto` was re-run on all 30 afterwards, and it picked the same model and effort for those 10.

## Decision

**M2's routing meets its exit criterion on this eval set.** `auto` costs 41% less per completed task than always-Opus, at the same success rate:

| route | passed | cost | per passed | mean time | escalations |
|---|---|---|---|---|---|
| `auto` | 30/30 | $7.36 | $0.245 | 32s | 0 |
| (a) `claude-code/opus/medium` | 30/30 | $12.53 | $0.418 | 43s | 0 |
| (b) `claude-code/sonnet/high` | 30/30 | $6.53 | $0.218 | 30s | 0 |

By the class the router gave each task:

| class | tasks | `auto` ran on | `auto` | (a) Opus medium | (b) Sonnet high |
|---|---|---|---|---|---|
| `code.edit.local` | 7 | Sonnet medium | $1.38 | $2.72 | $1.38 |
| `code.feature` | 7 | Sonnet medium | $1.36 | $2.98 | $1.57 |
| `test.write` | 6 | Sonnet medium | $1.06 | $2.21 | $1.16 |
| `debug.investigate` | 4 | Opus high | $2.31 | $1.89 | $0.90 |
| `code.edit.mechanical` | 3 | Sonnet low | $0.61 | $1.14 | $0.64 |
| `docs.write` | 2 | Sonnet low | $0.35 | $0.86 | $0.44 |
| `ask.explain` | 1 | Sonnet low | $0.30 | $0.73 | $0.45 |

Every route passed every task, so each cell's pass count is the class's task count.

**Always-Sonnet-high came out 11% cheaper than `auto`, all of it from `debug.investigate`.** The balanced policy sends that class to Opus at high effort, which cost 2.6 times Sonnet high here with no gain in success. Leave the four `debug.investigate` tasks out and `auto` is 10% cheaper than Sonnet high.

**The policy stays as it is for now.** Four debugging tasks that passed on every route aren't evidence that Sonnet is enough for unknown root causes. Each of these prompts gave an exact reproduction in a named part of the code, and the class exists for work that doesn't.

## Consequences

- **The set is too easy to separate the routes.** "No drop in success rate" holds only because nothing failed anywhere, and the escalation ladder never ran. The next eval set needs tasks that some routes fail: vaguer debugging, larger features, and work across packages. Moving `debug.investigate` off Opus high waits for that set, or for real tasks that the user keeps moving down, which routing memory follows.
- **There is one run per task and route, and costs vary between runs.** The 10 tasks `auto` ran twice on identical routes differed by up to 20% per task, though less in total. The 41% gap over always-Opus is far outside that noise; the 11% gap to Sonnet high isn't.
- **The sample is narrow:** one TypeScript repo, small tasks written to fit a hidden test, and Claude Code on a subscription only. Baselines (c) and (d) of DESIGN §8.10 weren't run.
- **The batch leaks the hidden test's path.** It writes each task's `verify` into the copy's `.verdandi/routing.yaml`, so an agent that reads it learns where the test lives. No agent's tool call touched the eval set's folder. On `auto`, though, two runs of the rename task grepped `routing.yaml` for the old name and saw the verify command. A later eval set should hide `verify` from the agent.
- **Rerun the comparison when the policy or classifier changes.** `verdandi routing replay` shows which saved tasks a change would move. Only a batch run shows whether they still pass.
