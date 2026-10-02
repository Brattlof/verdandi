import { createHash } from "node:crypto";
import type { ProjectId, ThreadId, TrustedCommands, TrustPurpose } from "@verdandi/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** The name of an exact command list, in order: trusting it covers that list and no other. Pure, so the decider can use it. */
export const commandsHash = (commands: readonly string[]) => createHash("sha256").update(JSON.stringify(commands)).digest("hex");

/** Whether the user trusts command list `commands` in the project of thread `threadId`. */
export const isTrusted = (threadId: ThreadId, commands: readonly string[]) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{ hash: string }>`select c.hash from trusted_commands c join threads t on t.project_id = c.project_id
        where t.id = ${threadId} and c.hash = ${commandsHash(commands)}`,
      (rows) => rows.length > 0,
    ),
  );

/** The command lists the user trusted, in thread `threadId`'s project or in all, newest first. */
export const listTrusted = (threadId?: ThreadId) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{
        project_id: ProjectId;
        path: string;
        hash: string;
        purpose: TrustPurpose;
        commands: string;
        thread_id: ThreadId;
        trusted_at: string;
      }>`select c.project_id, p.path, c.hash, c.purpose, c.commands, c.thread_id, c.trusted_at
        from trusted_commands c join projects p on p.id = c.project_id
        where ${threadId === undefined ? sql`1 = 1` : sql`c.project_id = (select project_id from threads where id = ${threadId})`}
        order by c.trusted_at desc, c.rowid desc`,
      (rows): TrustedCommands[] =>
        rows.map((r) => ({
          projectId: r.project_id,
          projectPath: r.path,
          hash: r.hash,
          purpose: r.purpose,
          commands: JSON.parse(r.commands) as string[],
          threadId: r.thread_id,
          trustedAt: r.trusted_at,
        })),
    ),
  );
