# 0033 · A recall exam for context compression

## Status

Accepted (issue #207, 2026-10-04; #186's compressor and its numbers added the same day). The design and the offline results are final; the first live run is pending (below).

## Context

The native harness needs context compression (DESIGN §16, #186), and #186 has to choose a trigger, a tail budget and summary sections. Nothing could tell a good compression from a bad one. Hermes built a recall exam before tuning its compressor: its old policy kept about three times the tokens for worse recall ([SCORECARD-2026-08-15](https://github.com/NousResearch/hermes-agent/blob/009afb3/evals/compaction/results/SCORECARD-2026-08-15.md)), and the same exam ruled out Jev's keep-or-drop ([SCORECARD-2026-09-19-jev](https://github.com/NousResearch/hermes-agent/blob/009afb3/evals/compaction/results/SCORECARD-2026-09-19-jev.md)).

Verdandi's database has no long native tasks yet, so `verdandi trajectories export` can't supply transcripts. The developer chose this repository's own Claude Code sessions instead, and chose to keep them out of the repo.

## Decision

1. **The exam set** is four real long coding sessions on this repo, converted to native transcripts (about 240K tokens each), with 26–27 questions each, 106 in all: 83 `exact` and 23 `judged`. They live in the gitignored `evals/compression/private/`, which `scripts/check-committed.ts` refuses to see tracked. The repo commits the converter, the question format (`CompressionExam` in contracts), the scoring, the runner and a synthetic transcript built in a test.
2. **Conversion** (`apps/agent/src/compression/exam-convert.ts`): the session's main conversation in file order. Each real user message starts a turn, a message queued while the agent worked joins the next user message as a steer would, tool calls stay paired with their results, and a result that came back after the agent moved on (a background task's) becomes text. Thinking, images, meta messages and subagents' own steps are left out. The trajectories redactor masks secrets, and the prefix's tools are the ones the session called.
3. **Questions** have exact answers copied from the transcript (paths, SHAs, error strings, issue and PR numbers, commands, test counts) or are judged (decisions the user made or rejected, reasons), each naming the verbatim evidence it rests on. All but a few sit before the session's last 25K tokens, so they ask about what a compression would remove. The whole transcript must hold every answer: the runner fails the exam otherwise.
4. **Offline score**, in `bun test` and the runner's default: a policy compresses the transcript at its end, the native adapter resumes the result and builds the next request on the fake provider, and the score is the request's estimated tokens and the share of questions whose answer (or evidence) it still holds, matched as strings after normalizing whitespace and slashes. It measures what the mechanical parts keep, with no model call.
5. **Live run** (`--live --max-usd <n>`, a manual script never run in tests): a model (default `claude-sonnet-5-5`, no tools, no thinking) answers each question closed-book from each policy's request, with the request cached once per policy. Exact answers are matched as strings, and `claude-haiku-4-5` grades the judged ones. It prints its estimated cost first and refuses to start past `--max-usd` or what the profile's spend caps leave; its spend isn't in Verdandi's ledger.
6. **Arms:** `full` (no compression in a window that holds it all: the ceiling), `truncate` (no compression in a window too small: the newest messages that fit), `recency` (a recency-only tail of the compressor's budget, and nothing else) and `lean`, #186's compressor itself (`packages/harness-native/src/compress.ts`): prune, then a summary, the anchor index and the user's messages verbatim before a recent tail. Offline its summary is scripted, every section "None.", so its score is what the mechanical parts keep; live it's the real `aux.compress` prompt on Haiku. `name@<tokens>` sets an arm's tail. Keep-or-drop stays out until a decision backend can answer it, and it would have to beat `recency` at a matched token budget to come back.
7. **Replay** (`--trigger <share>`): `lean` arms replay each session as it grew, compressing each time its request passed that share of the window, as the native harness does, so a trigger's cost in compressions (each a cache break and a summary) shows beside what's left at the end.
8. **#186's numbers, chosen offline here** (the live run can revise them):
   - **Tail: 12.5% of the window, clamped to 10K–25K tokens,** 25K on every window the native harness runs today. A 25K tail held 9.3 points more of the answers than 10K for 14K more tokens; 50K held 6.6 more for 25K more.
   - **Trigger: 80% of a window under 512K tokens, 50% of a larger one.** Replayed in Haiku's 200K window, 50% compressed each session two or three times and 80% once, and 80% ended with as many answers held or more. These transcripts (about 240K tokens) never reach half of a 1M window, so 50% there is DESIGN's and Hermes's default, unmeasured here.
   - **Prune over 8,000 characters,** older than the tail; anything older than the tail goes into the summary anyway, so pruning only decides whether a summary is needed at all.

**Offline results** (200K-token window, tokens estimated as a quarter of the request's JSON; `lean` and `recency` at the chosen 25K tail):

| transcript | `full` | `truncate` | `recency` | `lean` |
|---|---|---|---|---|
| 056abb0c (issues #51–#53) | 100% @ 257K | 88.9% @ 136K | 22.2% @ 25K | 59.3% @ 33K |
| 3d7868e6 (CLI and terminal UI, 19 turns) | 100% @ 243K | 69.2% @ 136K | 3.8% @ 25K | 46.2% @ 29K |
| 94aafb6a (#188, #204, #185) | 100% @ 239K | 92.3% @ 132K | 42.3% @ 25K | 57.7% @ 28K |
| e438b649 (all open issues) | 100% @ 237K | 92.6% @ 136K | 55.6% @ 26K | 63.0% @ 28K |
| **average** | 100% @ 244K | 85.8% @ 135K | 31.0% @ 25K | 56.5% @ 29K |

By tail, averaged over the four:

| tail | `recency` | `lean` |
|---|---|---|
| 10K | 6.6% @ 11K | 47.2% @ 15K |
| 25K | 31.0% @ 25K | 56.5% @ 29K |
| 50K | 40.4% @ 50K | 63.1% @ 54K |

Replayed with `lean@25000` in a 200K window: at a 50% trigger 2–3 compressions per session and 78.3% held at the end (about 86K tokens); at 65%, 1–2 and 63.0%; at 80%, one and 89.5% (about 133K, since more of each session is still uncompressed at its end).

**Live run:** pending. Its estimate for the four arms is $13.73, or $1.19 for `lean` alone and $2.04 for `recency` and `lean`; the developer decides when to spend it, and its results go here.

## Consequences

- `lean` holds 25 points more of the answers than a recency tail of the same size, for about 4K more tokens: the anchor index and the user's own words carry the needles a tail loses. At a 10K tail the gap is 41 points. A summary model's sections come on top, measured only live.
- Truncation holds most answers offline because long sessions restate their facts (PR numbers, paths) near the end. The live run will show how much of that a model can still find; offline presence is an upper bound on recall.
- The converter's sessions are Claude Code's, not the native harness's: tool names and outputs differ from what a native session holds, and there's no thinking. The scores compare policies on the same transcripts, not harnesses.
- The redactor masks known secret shapes only. One bare dev-server token (64 hex characters) passed through and was masked by hand in the private copy; rerunning the converter brings it back.
