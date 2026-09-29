import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway Goldiloop home. The path contains a space on purpose (Windows paths with spaces). */
export const makeTempHome = () => mkdtempSync(join(tmpdir(), "goldiloop test "));

export const removeTempHome = (home: string) => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EBUSY") throw e;
    // ponytail: @effect/sql-sqlite-bun closes the Database while bun:sqlite still holds cached
    // statements, so on Windows the file stays locked until they are garbage-collected. Only tests
    // reopen and delete databases. Upgrade path: drop this once the client finalizes statements on close.
    Bun.gc(true);
    rmSync(home, { recursive: true, force: true });
  }
};
