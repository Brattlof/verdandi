import { join } from "node:path";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { migrations } from "./migrations.ts";

/**
 * How big the WAL file may stay once a checkpoint has run. A healthy WAL stays near SQLite's automatic checkpoint
 * (1,000 pages, about 4 MB); a burst of writes grows it past that, and without a limit the file never shrinks again.
 */
export const walSizeLimit = 16 * 1024 * 1024;

/** The profile's database at `<home>/verdandi.db` (WAL, kept under `walSizeLimit`), migrated to the latest schema. */
export const SqlLive = (home: string) =>
  SqliteMigrator.layer({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(
    Layer.provideMerge(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`PRAGMA journal_size_limit = ${walSizeLimit}`);
        }),
      ).pipe(Layer.provideMerge(SqliteClient.layer({ filename: join(home, "verdandi.db") }))),
    ),
  );
