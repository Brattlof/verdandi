# 0009 · The decision layer starts on rules, not Laya

## Status

Accepted (M0 spike 009, 2026-09-29).

## Context

DESIGN §9.8 made Laya, an open-weights decision model run on CPU through ONNX, the default backend of the decision layer, with routing classification (§8.4) as its first use. Appendix D asked whether Laya runs under Bun, how fast, and how accurate it is out of the box on the task taxonomy compared with `rules`.

Spike 009 ran the English Laya model (fp32 ONNX) inside Bun 1.3.14 on Windows 11 through `onnxruntime-node`, on an i7-10750H CPU, against 52 hand-written prompts over the 13 task classes.

## Decision

1. `rules` is the default backend for every decision kind, including routing classification.
2. Laya is an optional backend. It is enabled per question kind only after an eval on logged Goldiloop decisions shows it beats `rules` there, normally after fine-tuning (§14.7).
3. When Laya is enabled, it runs in a separate worker process, not inside goldiloopd, and only for judgments that tolerate about a second of latency.

## Consequences

- Laya runs under Bun (no published `laya-ts` package was usable; a ~200-line runner on `onnxruntime-node` works).
- Out of the box it scored 63% against 81% for a keyword classifier, reported ~0.93 confidence regardless, and gave nearly the same difficulty score to every class. The rules figure is optimistic because the same author wrote rules and eval set, but Laya lost clearly on several classes.
- A routing request costs ~1.45 s of CPU and the model holds ~1.7 GB of memory, too much for the per-turn path or for goldiloopd's own process.
- M2's exit criterion (30% cheaper than always-Opus) must be reached on `rules` first. Decision logging from M1 builds the eval and fine-tuning set Laya needs.
- DESIGN §9.8's backend table and §21's M2 scope change accordingly.
