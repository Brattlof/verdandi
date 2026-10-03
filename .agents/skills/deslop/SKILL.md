---
name: deslop
description: Behaviour-preserving cleanup of AI slop in the current branch's diff (narrating comments, defensive checks for states that can't happen, type-laundering casts, one-use helpers, shims, style drift). Use before requesting a review, after finishing a change, or when asked to deslop.
license: MIT
---

# Deslop

Clean only the current branch's diff, before review. Behaviour stays exactly the same.

## Checklist

1. Scope the pass to `git diff $(git merge-base HEAD origin/main)`, plus uncommitted work. Never clean up the whole repo.
2. Read every changed hunk for:
   - comments a maintainer wouldn't write: narration, explanations of syntax, prose that restates the code. AGENTS.md: comments describe how something is used;
   - `try`/`catch` blocks, null checks and fallbacks that guard states the surrounding code can't reach, or that are unusual for that module. Keep validation at trust boundaries and error handling that prevents data loss;
   - casts that launder types: `as any`, `as unknown as T`, widening and then asserting. Fix the type instead;
   - intermediate variables and one-use helpers that add no domain meaning, remove no duplication and simplify no control flow;
   - re-export shims, aliases, retries and fallback branches with no named contract behind them;
   - names, control flow, imports and formatting that don't match the surrounding file.
3. Make no functional edits. If a cleanup could change behaviour, leave it and report it.
4. Fix a finding in place only when it is trivial and clearly behaviour-neutral. Otherwise note it for the author.
5. Run the tests for the files you touched and typecheck their scope (AGENTS.md "Verifying").
6. Report in one to three sentences: whether anything changed, and anything non-trivial left for review.

`ponytail-review` looks for over-engineering, deslop for slop. Run deslop before `requesting-code-review`, never instead of it: the review still owns correctness.
