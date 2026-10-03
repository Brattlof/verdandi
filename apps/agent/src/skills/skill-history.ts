import { historyLabel, type SkillChange, type SkillHistoryEntry, type ThreadId } from "@verdandi/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ProfileSkills } from "../event-store/reactor.ts";
import { revertBlocked } from "./skill-files.ts";

/**
 * The changes written to skill `skill` (DESIGN §14.4), newest first, failed ones included: each proposal the user
 * allowed and each revert, with why reverting it now would be refused, read from disk.
 */
export const loadSkillHistory = (skill: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const folders = yield* ProfileSkills;
    const rows = yield* sql<{ id: string; threadId: ThreadId; at: string; change: string; reverts: string | null; error: string | null }>`
      select id, thread_id as threadId, applied_at as at, change, reverts, error from skill_changes
      where skill = ${skill} and applied_at is not null order by applied_at desc, rowid desc`;
    return rows.map((r): SkillHistoryEntry => {
      const change = JSON.parse(r.change) as SkillChange;
      const blocked = r.error === null ? revertBlocked(folders, change) : "It wasn't written, so there's nothing to revert.";
      return {
        changeId: r.id,
        threadId: r.threadId,
        at: r.at,
        change,
        ...(r.reverts !== null && { reverts: r.reverts }),
        ...(r.error !== null && { error: r.error }),
        ...(blocked !== undefined && { blocked }),
      };
    });
  });

/** The history numbered newest first, as `verdandi skills revert <name> <n>` and `/skills revert` count it. */
export const historyText = (skill: string, entries: readonly SkillHistoryEntry[]) =>
  entries.length === 0
    ? `No change to ${skill} was written by Verdandi yet.\n`
    : `${entries
        .map((e, i) => {
          const status = e.error ? `  failed: ${e.error}` : e.blocked ? `  (can't revert: ${e.blocked})` : "";
          return `  ${i + 1}. ${e.at.slice(0, 16).replace("T", " ")}  ${historyLabel(e)}  thread ${e.threadId}${status}`;
        })
        .join("\n")}\n`;
