---
name: test-audit
description: A gate for every test you write or change, and an audit for low-value tests (restating the implementation, duplicating stronger tests, or keeping test-only seams alive in production code). Use when writing, changing, reviewing or pruning tests.
license: MIT
---

# Test Audit

Two modes, one bar. The authoring gate checks every new or changed test as you write it. An audit hunts for existing tests that fall below the bar and removes or moves them, in small batches. Aim for confidence, not deletion counts.

AGENTS.md "Verifying" sets the rules this skill applies; where they differ, AGENTS.md wins.

## Authoring gate

Before adding a test, answer four questions. A missing answer means don't add it yet.

1. What observable behaviour, invariant or contract does it protect?
2. What credible regression makes it fail?
3. Why don't existing tests already catch that? Each contract has one primary test at the strongest boundary (for a command, usually through the engine: dispatch it, wait on the receipt, read the projection). Another layer needs a distinct risk of its own. Prefer adding a case to an existing table or shared fixture over a near-duplicate test.
4. Does it need a seam in production code (an export, flag, wrapper or injection hook) that no production caller needs? Then test at the real boundary instead.

Then check it against every junk pattern below. A match fails the gate unless the retention bar names the contract it guards on its own. A test that breaks under a behaviour-preserving refactor is asserting implementation; rewrite it at the owning boundary.

A bug fix's test must fail on the code before the fix, for the intended reason, and pass after it. One that never failed proves the mock, not the fix. One test at the owning boundary covers the bug; don't replay it at every layer it crosses.

## Junk patterns

- assertion-free tests that only run code;
- self-comparisons, and copies compared with their originals;
- copied fixtures, inventories, catalogue counts or export lists (tests that freeze current values);
- greps of source text, imports or exact strings (tests that read source text);
- tests of private predicates or call shapes that the real boundary already covers;
- the same contract invoked twice;
- tests whose only purpose is keeping a test-only export, global or wrapper alive;
- production code whose only callers are tests;
- expected values produced by the helper or renderer under test;
- mocks that implement the behaviour being asserted, or one mock standing in for different APIs;
- fixtures that supply the receipt, event order or callback the code under test should produce, or persistence asserted against a store the path never writes;
- capability tests that restate declared flags instead of exercising what the flag promises;
- negative tests that pass for an unrelated reason, such as a rejection from a different guard;
- names or fixtures that promise more than the input exercises;
- sleeps, polling or timeouts standing in for waiting on receipts and drained workers.

## Retention bar

Keep a test when it guards on its own a contract that is expensive to break: a schema in `packages/contracts`, a past event's schema and its upgrade (events stay readable forever), a migration, security, a config file's errors, an OS-specific behaviour on its own OS, the cache rule (a session's system prompt and tool list stay fixed), routing golden tests and reason strings. Also keep:

- call order, when the order is observable;
- regressions with a credible failure mode;
- a kept test that fails on the baseline: treat it as a possible product bug, reproduce it, and fix the owner instead of deleting the test.

Slow or static is not a reason to delete. A test that looks like the implementation may still be the only guard of a contract; prove otherwise before removing it.

## Audit

Keep discovery read-only and show the evidence before editing. Prefer a few high-confidence candidates over a long speculative list. Before judging one, read the whole test, the production code it covers with its callers, overlapping tests, the area's `AGENTS.md`, and the history (`git log -L` or blame) for why it exists.

Record for each candidate, before editing; a missing field means it isn't ready:

- the test's name and location;
- what failure it can actually detect;
- non-test callers of the code or seam it covers;
- the stronger test that still covers it, or why none is needed;
- why it exists;
- what production or test-support code its removal lets you delete;
- the risk, and the `bun test <files>` command that checks it.

## Edit shape

Change one coherent batch at a time. Delete the test-only exports, wrappers and dead production paths it kept alive instead of keeping aliases (no re-export shims), and move kept regressions to their owning boundary. Prefer fewer production lines. Don't add replacement tests that restate the same implementation, and don't turn uncertain candidates into deletions.

Then run `bun test` on the touched and sibling test files, typecheck the scope you changed, and `git diff --check`. Report production lines changed separately from test lines, what you removed and why, what you kept that looked like junk and why, and the checks you ran.
