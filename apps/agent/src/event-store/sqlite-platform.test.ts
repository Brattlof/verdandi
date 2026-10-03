import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

// Session search depends on FTS5 with the trigram tokenizer (ADR 0006). On macOS Bun links the
// system SQLite, so this runs on every OS in CI. If it fails there, load a bundled SQLite with
// Database.setCustomSQLite() on that platform.
test("bun:sqlite has FTS5 with a diacritic-insensitive trigram tokenizer", () => {
  const db = new Database(":memory:");
  db.run("create virtual table t using fts5(body, tokenize = 'trigram remove_diacritics 1')");
  db.run("insert into t (body) values (?), (?)", ["Refactored useThreadStore hook", "Räksmörgås på fredag"]);
  const match = (q: string) => (db.query("select body from t where t match ?").all(`"${q}"`) as { body: string }[]).map((r) => r.body);
  expect(match("ThreadSto")).toEqual(["Refactored useThreadStore hook"]);
  expect(match("smorgas")).toEqual(["Räksmörgås på fredag"]);
  db.close();
});
