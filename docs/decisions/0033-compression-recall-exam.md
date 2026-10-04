# 0033 · A recall exam for context compression

## Status

Accepted (issue #207, 2026-10-04). The design and the offline results are final; the first live run is pending (below).

## Context

The native harness needs context compression (DESIGN §16, #186), and #186 has to choose a trigger, a tail budget and summary sections. Nothing could tell a good compression from a bad one. Hermes built a recall exam before tuning its compressor: its old policy kept about three times the tokens for worse recall ([SCORECARD-2026-08-15](https://github.com/NousResearch/hermes-agent/blob/009afb3/evals/compaction/results/SCORECARD-2026-08-15.md)), and the same exam ruled out Jev's keep-or-drop ([SCORECARD-2026-09-19-jev](https://github.com/NousResearch/hermes-agent/blob/009afb3/evals/compaction/results/SCORECARD-2026-09-19-jev.md)).

Verdandi's database has no long native tasks yet, so `verdandi trajectories export` can't supply transcripts. The developer chose this repository's own Claude Code sessions instead, and chose to keep them out of the repo.

## Decision

1. **The exam set** is four real long coding sessions on this repo, converted to native transcripts (about 240K tokens each), with 26–27 questions each, 106 in all: 83 `exact` and 23 `judged`. They live in the gitignored `evals/compression/private/`, which `scripts/check-committed.ts` refuses to see tracked. The repo commits the converter, the question format (`CompressionExam` in contracts), the scoring, the runner and a synthetic transcript built in a test.
2. **Conversion** (`apps/agent/src/compression/exam-convert.ts`): the session's main conversation in file order. Each real user message starts a turn, a message queued while the agent worked joins the next user message as a steer would, tool calls stay paired with their results, and a result that came back after the agent moved on (a background task's) becomes text. Thinking, images, meta messages and subagents' own steps are left out. The trajectories redactor masks secrets, and the prefix's tools are the ones the session called.
3. **Questions** have exact answers copied from the transcript (paths, SHAs, error strings, issue and PR numbers, commands, test counts) or are judged (decisions the user made or rejected, reasons), each naming the verbatim evidence it rests on. All but a few sit before the session's last 25K tokens, so they ask about what a compression would remove. The whole transcript must hold every answer: the runner fails the exam otherwise.
4. **Offline score**, in `bun test` and the runner's default: a policy compresses the transcript at its end, the native adapter resumes the result and builds the next request on the fake provider, and the score is the request's estimated tokens and the share of questions whose answer (or evidence) it still holds, matched as strings after normalizing whitespace and slashes. It measures what the mechanical parts keep, with no model call.
5. **Live run** (`--live --max-usd <n>`, a manual script never run in tests): a model (default `claude-sonnet-5-5`, no tools, no thinking) answers each question closed-book from each policy's request, with the request cached once per policy. Exact answers are matched as strings, and `claude-haiku-4-5` grades the judged ones. It prints its estimated cost first and refuses to start past `--max-usd` or what the profile's spend caps leave; its spend isn't in Verdandi's ledger.
6. **Arms:** `full` (no compression in a window that holds it all: the ceiling), `truncate` (no compression in a window too small: the newest messages that fit) and `recency` (a recency-only tail of 2.5% of the window, clamped to 10K–25K tokens, and nothing else). #186's policy joins them as `lean`. Keep-or-drop stays out until a decision backend can answer it, and it would have to beat `recency` at a matched token budget to come back.

**Offline results** (200K-token window, tokens estimated as a quarter of the request's JSON):

| transcript | `full` | `truncate` | `recency` |
|---|---|---|---|
| 056abb0c (issues #51–#53) | 100% @ 257K | 88.9% @ 136K | 7.4% @ 11K |
| 3d7868e6 (CLI and terminal UI, 19 turns) | 100% @ 243K | 69.2% @ 136K | 3.8% @ 11K |
| 94aafb6a (#188, #204, #185) | 100% @ 239K | 92.3% @ 132K | 7.7% @ 10K |
| e438b649 (all open issues) | 100% @ 237K | 92.6% @ 136K | 7.4% @ 10K |
| **average** | 100% @ 244K | 85.8% @ 135K | 6.6% @ 11K |

**Live run:** pending. Its estimate for these three arms is $12.10, or $0.40 for `recency` alone; the developer decides when to spend it, and its results go here.

## Consequences

- Truncation holds most answers offline because long sessions restate their facts (PR numbers, paths) near the end. The live run will show how much of that a model can still find; offline presence is an upper bound on recall.
- A recency-only tail holds under a tenth of the answers: whatever #186 adds (verbatim user messages, the anchor index, the summary) has to earn its tokens against that floor.
- The exam measures one compression at the session's end. Repeated compressions, and how often each breaks the cache, aren't measured yet.
- The converter's sessions are Claude Code's, not the native harness's: tool names and outputs differ from what a native session holds, and there's no thinking. The scores compare policies on the same transcripts, not harnesses.
- The redactor masks known secret shapes only. One bare dev-server token (64 hex characters) passed through and was masked by hand in the private copy; rerunning the converter brings it back.
