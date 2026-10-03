import { randomUUID } from "node:crypto";
import type { CommandId, SkillCuration, SkillState, ThreadId } from "@verdandi/contracts";
import { Effect, Layer, Schedule } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Engine } from "../event-store/engine.ts";
import { ProfileSkills } from "../event-store/reactor.ts";
import { listSkills, placeSkill } from "./skill-files.ts";

const day = 24 * 60 * 60 * 1000;
/** DESIGN §14.4: a skill Verdandi created goes stale after 14 days unused, and is archived after 30. */
const staleAfter = 14 * day;
const archiveAfter = 30 * day;

const curated = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<{ name: string; state: SkillState; usedAt: string; threadId: ThreadId }>`
    select name, state, used_at as usedAt, thread_id as threadId from skills`,
);

/** The Skills panel's view: the skill folders read from disk, each skill Verdandi created with its curation. */
export const loadSkillsView = Effect.gen(function* () {
  const folders = yield* ProfileSkills;
  const rows = yield* curated;
  return listSkills(
    folders,
    new Map(rows.map((r): [string, SkillCuration] => [r.name, { state: r.state, usedAt: r.usedAt, threadId: r.threadId }])),
  );
});

/**
 * The curate step (DESIGN §14.4) at `now`: moves each skill Verdandi created that went unused to stale or archived,
 * through `skill.curate`, whose reactor moves an archived one out of the loaded folder. First it puts every such
 * skill's folder where its state says, so a move that failed before is tried again. User-written skills have no row.
 */
export const curateSkills = (now: number) =>
  Effect.gen(function* () {
    const engine = yield* Engine;
    const folders = yield* ProfileSkills;
    for (const skill of yield* curated) {
      const error = placeSkill(folders, skill.name, skill.state === "archived");
      if (error) yield* Effect.logWarning(`${error} The next sweep tries again.`);
      if (skill.state === "archived") continue;
      const unused = now - Date.parse(skill.usedAt);
      const to = unused >= archiveAfter ? "archived" : unused >= staleAfter ? "stale" : undefined;
      if (to && to !== skill.state)
        yield* engine.dispatch({
          type: "skill.curate",
          commandId: randomUUID() as CommandId,
          threadId: skill.threadId,
          skill: skill.name,
          to,
          usedAt: skill.usedAt,
        });
    }
  });

/** Curates when verdandid starts, then once a day. A failure is logged, and the next day's sweep tries again. */
export const SkillCurationScheduleLive = Layer.effectDiscard(
  Effect.forkScoped(
    Effect.suspend(() => curateSkills(Date.now())).pipe(
      Effect.ignoreCause({ log: "Warn", message: "The skill curation sweep failed; the next one tries again." }),
      Effect.repeat(Schedule.spaced("1 day")),
    ),
  ),
);
