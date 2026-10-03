import type { CapPeriod, CapScope, HarnessId, ProjectId, Quota, SpendCap } from "@verdandi/contracts";
import { Effect, Result } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { projectIdFor } from "../event-store/decider.ts";
import type { SpendCaps } from "./spend-caps.ts";

const pad = (n: number) => String(n).padStart(2, "0");

/** The local calendar day and month containing `now`: each one's key, and its start as an ISO timestamp. */
export const periodsAt = (now: Date): Record<CapPeriod, { readonly key: string; readonly since: string }> => {
  const [y, m, d] = [now.getFullYear(), now.getMonth(), now.getDate()];
  return {
    day: { key: `${y}-${pad(m + 1)}-${pad(d)}`, since: new Date(y, m, d).toISOString() },
    month: { key: `${y}-${pad(m + 1)}`, since: new Date(y, m, 1).toISOString() },
  };
};

/**
 * What the decider knows about spend caps: those over the thread and the harnesses whose subscription is `paying`
 * on extra usage, or why the caps file can't be used.
 */
export type SpendState = Result.Result<
  { readonly file: string; readonly caps: readonly SpendCap[]; readonly paying: readonly HarnessId[] },
  string
>;

/**
 * The harnesses whose latest subscription window runs on extra usage as of `now`, priced as metered (ADR 0005).
 * A window whose reset time has passed no longer counts: its harness reports the new one on its next turn.
 */
export const loadPaying = (now: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ harness: HarnessId; payload: string }>`select harness, payload from quota`;
    return rows.flatMap((r) => {
      const quota = JSON.parse(r.payload) as Quota;
      const current = quota.resetsAt === undefined || Date.parse(quota.resetsAt) > now.getTime();
      return quota.usingOverage && current ? [r.harness] : [];
    });
  });

/**
 * The harnesses whose latest subscription window as of `now` is nearly used up, or used up with no extra usage paying
 * for more: background work stays off them (DESIGN §14.5). A window whose reset time has passed no longer counts.
 */
export const loadShortQuota = (now: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ harness: HarnessId; payload: string }>`select harness, payload from quota`;
    return rows.flatMap((r) => {
      const quota = JSON.parse(r.payload) as Quota;
      const current = quota.resetsAt === undefined || Date.parse(quota.resetsAt) > now.getTime();
      const short = quota.status === "allowed_warning" || (quota.status === "rejected" && !quota.usingOverage);
      return current && short ? [r.harness] : [];
    });
  });

/**
 * Each cap over `projectPath`'s threads as of `now`: the profile's first, then the project's. A cap's
 * limit is the configured one or the user's latest raise this period; its spend is metered usage since
 * the period began, which includes subscription turns on extra usage (DESIGN §8.9).
 */
export const loadSpendCaps = (caps: SpendCaps, projectPath: string, now: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = projectIdFor(projectPath);
    const periods = periodsAt(now);
    const configured: [CapScope, Partial<Record<CapPeriod, number>>][] = [
      ["profile", caps.profile],
      ["project", caps.projects.get(projectId) ?? {}],
    ];
    return yield* Effect.forEach(
      configured.flatMap(([scope, byPeriod]) =>
        (["day", "month"] as const).flatMap((period) => {
          const baseUsd = byPeriod[period];
          return baseUsd === undefined ? [] : [{ scope, period, baseUsd }];
        }),
      ),
      ({ scope, period, baseUsd }) =>
        Effect.gen(function* () {
          const { key, since } = periods[period];
          const owner: ProjectId | null = scope === "project" ? projectId : null;
          const [raised] = yield* sql<{ limit_usd: number }>`
            select limit_usd from spend_cap_raises
            where scope = ${scope} and period = ${period} and period_key = ${key} and project_id is ${owner}
            order by seq desc limit 1`;
          const [spent] = yield* sql<{ usd: number }>`
            select total(u.cost_usd) as usd from usage_ledger u join turns t on t.id = u.turn_id join threads h on h.id = t.thread_id
            where u.access_mode = 'metered' and u.at >= ${since} and (${owner} is null or h.project_id = ${owner})`;
          return {
            scope,
            period,
            periodKey: key,
            baseUsd,
            limitUsd: Math.max(baseUsd, raised?.limit_usd ?? 0),
            spentUsd: spent?.usd ?? 0,
          } satisfies SpendCap;
        }),
    );
  });

/** The decider's view of spend caps for a thread in `projectPath`, reading the caps file now. */
export const loadSpendState = (load: Effect.Effect<Result.Result<SpendCaps, string>>, projectPath: string, now: Date) =>
  Effect.gen(function* () {
    const caps = yield* load;
    if (Result.isFailure(caps)) return Result.fail(caps.failure) as SpendState;
    return Result.succeed({
      file: caps.success.file,
      caps: yield* loadSpendCaps(caps.success, projectPath, now),
      paying: yield* loadPaying(now),
    }) as SpendState;
  });
