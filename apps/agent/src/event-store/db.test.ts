import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { SqlLive, walSizeLimit } from "./db.ts";

test("a burst of writes grows the WAL past its bound, and the next write after a checkpoint shrinks it back", async () => {
  const home = makeTempHome();
  try {
    const walSize = () => statSync(join(home, "verdandi.db-wal")).size;
    const sizes = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`create table burst (data blob)`;
        const chunk = 1024 * 1024;
        yield* sql.withTransaction(
          Effect.forEach(Array.from({ length: walSizeLimit / chunk + 4 }), () => sql`insert into burst values (${randomBytes(chunk)})`, {
            discard: true,
          }),
        );
        const burst = walSize();
        yield* sql`pragma wal_checkpoint(passive)`;
        yield* sql`insert into burst values (null)`;
        return { burst, after: walSize() };
      }).pipe(Effect.scoped, Effect.provide(SqlLive(home))),
    );
    expect(sizes.burst).toBeGreaterThan(walSizeLimit);
    expect(sizes.after).toBeLessThanOrEqual(walSizeLimit);
  } finally {
    removeTempHome(home);
  }
});
