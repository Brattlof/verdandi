import { type Catalog, healthCovers, minSwitchResetMs, type ProviderFailure, type ProviderHealth, type Route } from "@verdandi/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { targetOf } from "./routing.ts";

/** The provider failures still in force at `now` (DESIGN §9.5): what keeps providers and models out of new routes. */
export const loadHealth = (now: Date) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql<{ provider: string; model: string; reason: ProviderFailure; until: string; reset: number; error: string }>`
      select provider, model, reason, until, reset, error from provider_health where until > ${now.toISOString()} order by provider, model`.pipe(
      Effect.map((rows) =>
        rows.map(
          (r): ProviderHealth => ({
            provider: r.provider,
            ...(r.model === "" ? {} : { model: r.model }),
            reason: r.reason,
            until: r.until,
            reset: r.reset === 1,
            error: r.error,
          }),
        ),
      ),
    ),
  );

/**
 * The failure that keeps `route` off its provider for the next turn: one the provider gave a reset for, still more than
 * `minSwitchResetMs` ahead at `now`. A sooner reset is waited out on the route, since every switch writes a cold cache.
 */
export const stickyFailure = (health: readonly ProviderHealth[], route: Route, catalog: Catalog, now: Date) => {
  const target = targetOf(route, catalog);
  return health.find(
    (h) => h.reset && healthCovers(h, target.provider, target.model) && Date.parse(h.until) - now.getTime() > minSwitchResetMs,
  );
};
