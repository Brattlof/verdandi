import { join } from "node:path";
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun";
import { Layer } from "effect";
import { migrations } from "./migrations.ts";

/** The profile's database at `<home>/verdandi.db` (WAL), migrated to the latest schema. */
export const SqlLive = (home: string) =>
  SqliteMigrator.layer({ loader: SqliteMigrator.fromRecord(migrations) }).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: join(home, "verdandi.db") })),
  );
