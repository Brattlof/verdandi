---
name: spike
description: Throwaway experiments that answer a feasibility question before the real build. Use when the user says "spike this", "let me try", "is this even possible", "before I commit to X", "compare A vs B", or when a design question (e.g. an M0 item in docs/DESIGN.md Appendix D) can only be settled by running code.
license: MIT
---

# Spike

A spike answers a question that docs and code-reading can't: does this work, how fast is it, which of two approaches wins. Spikes are disposable. Throw the code away once it has answered the question; keep the answer.

## When NOT to use this

- The answer is knowable from docs or from reading code: research it, don't build it.
- The work is on the production path: use `writing-plans` instead.
- The idea is already validated: go straight to implementation.

## Core loop

```
decompose → research → build → verdict
    ↑________________________________↓
          iterate on findings
```

### 1. Decompose

Break the idea into 2–5 independent feasibility questions, one spike each, phrased as Given/When/Then with observable output:

| # | Spike | Validates (Given/When/Then) | Risk |
|---|---|---|---|
| 001 | sdk-set-model | Given a streaming Agent SDK session, when `setModel("haiku")` is called mid-session, then the next turn runs on Haiku and keeps the transcript | High |
| 002a | pty-bun-pty | Given Windows 11, when a PowerShell PTY runs under `bun-pty`, then resize, Ctrl+C and 10k lines of output all behave | High |
| 002b | pty-helper-process | Same question, with the PTY in a small helper process | Medium |

- **standard:** one approach, one question.
- **comparison:** the same question with different approaches (shared number, suffix `a`/`b`/`c`).

Order by risk: run first the spike most likely to kill the idea. Skip decomposition only if the user already named a single, specific spike.

### 2. Align

Show the table and ask: "Build all in this order, or adjust?" Let the user drop, reorder or reframe before any code is written.

### 3. Research (per spike, before building)

1. **Brief it** in 2–3 sentences: what it is, why it matters, the key risk.
2. **List competing approaches** if there's a real choice (tool, pros, cons, maintained or not).
3. **Pick one** and say why. If two are credible, make it a comparison spike.
4. **Skip research** for pure logic with no external dependencies.

Read primary sources: the library's docs, README and examples, or its source. Check installed versions in `package.json` / `bun.lock` rather than guessing. Remember that release notes newer than your training data may exist.

### 4. Build

One directory per spike, standalone, under the gitignored `spikes/` folder:

```
spikes/
├── 001-sdk-set-model/
│   ├── README.md
│   └── main.ts
└── 002a-pty-bun-pty/
    ├── README.md
    └── main.ts
```

- **Make it observable.** In order of preference: a runnable CLI that prints results, a minimal HTML page, a one-endpoint server, a test with recognizable assertions. "It works" in a log line is not a verdict.
- **Depth over speed.** Never declare success after one happy-path run. Try edge cases, and follow surprising findings.
- **Hardcode everything.** No config systems, env files, Docker or build tooling unless the question is about them.
- **Parallel comparison spikes:** when 002a and 002b each need real engineering, dispatch one subagent per approach (see `dispatching-parallel-agents`). Each returns its own verdict; you write the head-to-head.

### 5. Verdict

Each spike's `README.md` ends with:

```markdown
## Verdict: VALIDATED | PARTIAL | INVALIDATED

### What worked
### What didn't
### Surprises
### Recommendation for the real build
```

- **VALIDATED:** the question was answered yes, with evidence.
- **PARTIAL:** it works under constraints X, Y, Z. List them.
- **INVALIDATED:** it doesn't work, for this reason. That is a successful spike.

For comparison spikes, finish with a head-to-head table: the dimensions that matter, measured values, and the winner.

### 6. Keep the answer

The spike code stays out of git. When a verdict settles a design question, record it as an ADR in `docs/decisions/` (see AGENTS.md), and update `docs/DESIGN.md` if the design changes. Link the ADR from the spike's README, not the other way round.

## Picking what to spike next

If spikes already exist and the user asks what's next, look for:
- **integration risks:** two validated spikes that touch the same resource but were tested separately;
- **data handoffs:** one spike's output assumed to fit another's input, never proven;
- **gaps:** capabilities the design assumes but nothing has proven;
- **alternatives** for PARTIAL or INVALIDATED spikes.

Propose 2–4 candidates as Given/When/Then and let the user pick.

## Attribution

Adapted from Hermes Agent's `spike` skill (MIT © 2025 Nous Research), which was itself adapted from the GSD project's `/gsd-spike` workflow (MIT © 2025 Lex Christopherson, [gsd-build/get-shit-done](https://github.com/gsd-build/get-shit-done)). See `LICENSE`.
