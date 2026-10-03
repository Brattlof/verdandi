# 0006 · Session search on bun:sqlite FTS5 with the trigram tokenizer

## Status

Accepted (M0 spike 006, 2026-09-29; macOS and Linux confirmed by CI the same day).

## Context

Session search (DESIGN §14.3) needs substring search over transcripts that are full of identifiers, paths and stack traces, in any language. The stack is Bun with `bun:sqlite` (§19). Appendix D asked whether FTS5 and the trigram tokenizer are available on all three OSes.

## Decision

1. Session search uses an FTS5 table with `tokenize = 'trigram remove_diacritics 1'` in the main SQLite database.
2. User input is always quoted as an FTS5 phrase before `MATCH`. Queries under 3 characters don't use the index.
3. `apps/agent/src/event-store/sqlite-platform.test.ts` checks FTS5 with the trigram tokenizer on Windows, macOS and Ubuntu in CI. If a platform's SQLite ever loses it, Verdandi loads a bundled SQLite there through `Database.setCustomSQLite()`.

## Consequences

- On Windows, Bun's SQLite 3.53.0 has FTS5 and trigram. Substring, case-insensitive, diacritic-insensitive and CJK matches work, and 100 queries over 50k rows took 13 ms.
- Trigram indexes are large (15 MB for 50k short rows), which is acceptable for local transcripts.
- Unquoted user text would fail on common input like file names, so the quoting helper is mandatory.
- macOS (where Bun uses the system SQLite) and Ubuntu pass the same check in CI, including substring and diacritic-insensitive matches.
