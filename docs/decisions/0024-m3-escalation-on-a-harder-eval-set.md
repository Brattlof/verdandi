# 0024 · M3 escalation measured on a harder eval set

## Status

Accepted (2026-10-02).

## Context

M3's exit criterion (DESIGN §21) includes "escalation fixes more than half of first-attempt failures". ADR 0017's eval set couldn't measure it: every route passed all 30 tasks, so nothing escalated. Issue #134 asked for a second set with tasks some routes fail. That set:

- **20 tasks on this repo,** in the developer's `~/verdandi-evals/m3/` (outside the repo, like the first; its README says how to run it). Each has a hidden test and a reference fix, and a check confirms every test fails at its base commit and passes, with the repo typechecking, once the fix is applied.
- **7 vague debugging tasks:** bug reports that give the symptom, not the file at fault, with the cause a few files or a package away. Five are planted in a commit with no parent, so `git show HEAD` doesn't reveal them; two are real bugs at 8fbedb9.
- **7 features across 2–4 packages,** with reference fixes of 34–99 lines over 3–11 files: thread rename, `@model:effort` pins, scoped verifiers, a `memory_forget` tool, turn retry, first-try batch reporting, a `maxMinutes` task limit.
- **6 mixed tasks:** two cross-package refactors (one creates `packages/memory` with a frozen lockfile), two test-writing tasks graded by killing 15 mutants each, and two edge-case edits (grapheme-aware memory caps, weekly caps on ISO weeks checked under seven time zones).

Each task ran once on `auto` (the built-in balanced policy) and on baselines (a) `claude-code/opus/medium` and (b) `claude-code/sonnet/high`, on main at ca7fd8b, with Claude Code on a subscription, requests approved, and a 30-minute limit per task. Since #147, a task's `verify` reaches the reactor without being written into the copy; no agent's tool call touched the eval set's folder, and its hidden tests were unchanged afterwards. One Opus run lost its turn to a Claude Code crash (SIGSEGV in its Bun runtime) and was run again.

## Decision

**M3's escalation criterion is still unmeasured: nothing failed on its first attempt, so nothing escalated.**

| route | passed | cost | per passed | mean time | escalations |
|---|---|---|---|---|---|
| `auto` | 20/20 | $6.29 | $0.315 | 54s | 0 |
| (a) `claude-code/opus/medium` | 20/20 | $16.22 | $0.811 | 112s | 0 |
| (b) `claude-code/sonnet/high` | 20/20 | $8.55 | $0.428 | 81s | 0 |

| tasks | `auto` | (a) Opus medium | (b) Sonnet high |
|---|---|---|---|
| debugging (7) | $1.59 | $4.64 | $2.08 |
| features (7) | $3.23 | $8.26 | $4.46 |
| mixed (6) | $1.47 | $3.32 | $2.02 |

All of `auto`'s tasks ran on Sonnet (14 at medium effort, 3 low, 3 high), and it cost 61% less per completed task than always-Opus and 26% less than always-Sonnet-high, at the same success rate. That holds M2's result on harder work. It isn't evidence about escalation.

**The criterion stays open.** Measuring it needs verifiers that see every change a turn makes, and tasks that fail on a first attempt (both under Consequences). Running a harder set before the first is fixed would undercount escalations again.

## Consequences

- **Most turns couldn't have escalated.** The reactor counts a turn as having changed files only through Claude Code's file tools (`Edit`, `MultiEdit`, `Write`, `NotebookEdit`), and runs verifiers only then. Sonnet made most of its edits through Bash (`sed`, `python3` heredocs, `cat >`), so verifiers ran on 6 of `auto`'s 20 turns, 7 of Sonnet high's and 14 of Opus's. Had those turns failed, nothing would have escalated, so the criterion could never pass. The turn's start checkpoint against the files once its agent is done is the reliable signal, whatever tool made the change.
- **The `rules` classifier can't read these prompts.** It was unsure of 14 of the 20 (confidence 0.25–0.5) and fell back to Sonnet medium. It labelled none of them `debug.investigate`, `code.feature` or `test.write`: a symptom-only bug report reads as `code.edit.local`, `code.refactor.large` or `ask.search`, four features as `chat.general`, and a test-writing task as `docs.write`. `auto` lost nothing here because Sonnet medium passed everything. ADR 0017's reason for keeping `debug.investigate` on Opus high never came into play, since no task reached that class.
- **Single-turn tasks with a stated spec are within reach of today's models.** Even the vague bug reports were solved in under a minute on Sonnet medium. Tasks that fail on the first attempt probably need what this set avoided: no hidden test to aim at in the prompt (larger specs only checkable end to end), long multi-step work, or unfamiliar repositories. A set of real failures (turns the user corrected or reverted) is likely the better source than more invented ones.
- **An escalated turn sees the verifier's command,** including where the hidden test lives, and with `--approve` could read it. A project's own verifier is just as visible, so it's realistic, but an eval should count a pass after escalation as weaker evidence than a first-try pass.
- **One run per task and route,** as in ADR 0017: the 26% gap to Sonnet high is within what reruns could move; the 61% gap to Opus isn't.
