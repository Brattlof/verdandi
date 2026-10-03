import { randomUUID } from "node:crypto";
import type { CommandId, Event, SkillChange } from "@verdandi/contracts";
import { type ProposeSkill, ToolFailed } from "@verdandi/tools";
import { Deferred, Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { Engine } from "../event-store/engine.ts";
import { applyChange, prepareChange, type SkillFolders } from "./skill-files.ts";

type Dispatch = Engine["Service"]["dispatch"];
type Resolved = Extract<Event, { type: "approval.resolved" }>;

const done: Record<SkillChange["action"], (c: SkillChange) => string> = {
  create: (c) => `created the skill ${c.skill}`,
  patch: (c) => `patched ${c.skill}/${c.path}`,
  write_file: (c) => `wrote ${c.skill}/${c.path}`,
  delete: (c) => `deleted the skill ${c.skill} (its folder moved to the archive)`,
};

/**
 * Skill proposals (DESIGN §14.4): `propose` serves `skill_manage`, reading the skill's file, recording the proposal
 * as a pending request and waiting for the user; `settle` runs in the reactor on each `approval.resolved`, writes an
 * allowed proposal to disk, records how that went, and answers the waiting tool call.
 */
export const makeSkillProposals = (dispatch: Dispatch, folders: SkillFolders, sql: SqlClient.SqlClient) => {
  /** Tool calls waiting for the user, by request id (the proposal's command id). */
  const waiting = new Map<string, Deferred.Deferred<string, ToolFailed>>();

  const propose: ProposeSkill = (edit, at) =>
    Effect.gen(function* () {
      const prepared = yield* Effect.try({
        try: () => prepareChange(folders, edit),
        catch: (e) => new ToolFailed({ message: `Couldn't read the skill ${edit.skill}: ${e instanceof Error ? e.message : String(e)}` }),
      });
      if ("error" in prepared) return yield* new ToolFailed({ message: prepared.error });
      const commandId = randomUUID() as CommandId;
      const answer = yield* Deferred.make<string, ToolFailed>();
      // Registered before the proposal commits, so an answer can never arrive first.
      waiting.set(commandId, answer);
      return yield* dispatch({ type: "skill.propose", commandId, ...at, change: prepared.change }).pipe(
        Effect.catchTag("CommandRejected", (e) => Effect.fail(new ToolFailed({ message: e.message }))),
        Effect.catchTag("SqlError", Effect.die),
        Effect.andThen(Deferred.await(answer)),
        Effect.ensuring(Effect.sync(() => waiting.delete(commandId))),
      );
    });

  const settle = (e: Resolved) => {
    const answer = waiting.get(e.requestId);
    return Effect.gen(function* () {
      const [row] = yield* sql<{ payload: string }>`select payload from requests where id = ${e.requestId} and kind = 'skill'`;
      if (!row) return;
      const { change } = JSON.parse(row.payload) as Extract<Event, { type: "skill.proposed" }>;
      if (e.resolution.decision !== "allow") {
        const feedback = e.resolution.decision === "deny" ? e.resolution.feedback : undefined;
        const why = e.reason ?? `The user declined it${feedback ? `: ${feedback}` : "."}`;
        if (answer) yield* Deferred.fail(answer, new ToolFailed({ message: `Nothing was written. ${why}` }));
        return;
      }
      const error = applyChange(folders, change);
      const { action, skill, path } = change;
      yield* dispatch({
        type: "skill.report",
        commandId: randomUUID() as CommandId,
        threadId: e.threadId,
        turnId: e.turnId,
        requestId: e.requestId,
        action,
        skill,
        path,
        ...(error && { error }),
      });
      if (answer)
        yield* error
          ? Deferred.fail(answer, new ToolFailed({ message: error }))
          : Deferred.succeed(answer, `The user approved it: ${done[action](change)} in the profile's skills folder. New sessions load it.`);
    }).pipe(
      // The agent hears it too, so its call never waits on a proposal nobody will settle.
      Effect.catchCause((cause) =>
        Effect.andThen(
          Effect.logWarning(`Could not settle skill proposal ${e.requestId}.`, cause),
          answer
            ? Deferred.fail(
                answer,
                new ToolFailed({ message: "Verdandi couldn't finish this skill change; the user can check verdandid's log." }),
              )
            : Effect.void,
        ),
      ),
    );
  };

  return { propose, settle };
};
