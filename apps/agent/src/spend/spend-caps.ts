import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CapPeriod, ProjectId } from "@verdandi/contracts";
import { Effect, Result, Schema } from "effect";
import { projectIdFor } from "../event-store/decider.ts";
import { resolveProjectPath } from "../projects/project.ts";

const Usd = Schema.Number.check(Schema.isGreaterThan(0));
const Caps = Schema.Struct({ daily: Schema.optionalKey(Usd), monthly: Schema.optionalKey(Usd) });

/**
 * `spend-caps.yaml` in the Verdandi home: metered spend caps in USD (DESIGN §8.9), for the whole profile
 * and per project folder. Subscription usage never counts; extra usage on a subscription does.
 */
const SpendCapsFile = Schema.Struct({ ...Caps.fields, projects: Schema.optionalKey(Schema.Record(Schema.String, Caps)) });

/** The caps in force: USD per period, for the profile and by project. */
export type SpendCaps = {
  /** Where they're configured, for messages that say how to change one. */
  readonly file: string;
  readonly profile: Partial<Record<CapPeriod, number>>;
  readonly projects: ReadonlyMap<ProjectId, Partial<Record<CapPeriod, number>>>;
};

export const spendCapsFile = (home: string) => join(home, "spend-caps.yaml");

const periods = (c: typeof Caps.Type) => ({ ...(c.daily && { day: c.daily }), ...(c.monthly && { month: c.monthly }) });

/**
 * Reads the home's `spend-caps.yaml` on each call, so an edit applies to the next turn. A missing file
 * means no caps; a broken one is reported naming the file and the key.
 */
export const loadSpendCaps = (home: string): Effect.Effect<Result.Result<SpendCaps, string>> =>
  Effect.sync(() => {
    const file = spendCapsFile(home);
    if (!existsSync(file)) return Result.succeed({ file, profile: {}, projects: new Map() });
    try {
      const data = Schema.decodeUnknownSync(SpendCapsFile)(Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}, {
        onExcessProperty: "error",
        errors: "all",
      });
      // Keyed like projects themselves, so `~`, symlinks, a trailing slash, slash direction and drive letter case don't
      // matter. A folder that isn't there (yet) holds no project, so it keeps its spelling until it exists.
      const folder = (path: string) => Effect.runSync(resolveProjectPath(path).pipe(Effect.orElseSucceed(() => path)));
      const projects = Object.entries(data.projects ?? {}).map(([path, caps]) => [projectIdFor(folder(path)), periods(caps)] as const);
      return Result.succeed({ file, profile: periods(data), projects: new Map(projects) });
    } catch (e) {
      return Result.fail(`${file}: ${e instanceof Error ? e.message : String(e)}\nFix the file, or delete it to turn spend caps off.`);
    }
  });
