import { afterEach, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, Item, ThreadId, TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { migrations } from "../event-store/migrations.ts";
import { loadThreadView } from "../event-store/projector.ts";
import { type ProfileSkills, Reactor } from "../event-store/reactor.ts";
import { curateSkills, loadSkillsView } from "./skill-curation.ts";

const dirs: string[] = [];
const runtimes: ManagedRuntime.ManagedRuntime<unknown, unknown>[] = [];
afterEach(async () => {
  setSystemTime();
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const d of dirs.splice(0)) removeTempHome(d);
});
let n = 0;
const id = <T>() => `id-${++n}` as T;
const day = 24 * 60 * 60 * 1000;
const skill = (name: string) => `---\nname: ${name}\ndescription: How this user ships.\n---\nSteps.\n`;

test("an unused skill Verdandi created goes stale, then archived out of the loaded folder; a used one stays active; restore brings it back", async () => {
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  setSystemTime(new Date(t0));
  const home = makeTempHome();
  dirs.push(home);
  const skills = join(home, "skills");
  // A skill the user wrote by hand: never Verdandi's to move.
  mkdirSync(join(skills, "mine"), { recursive: true });
  writeFileSync(join(skills, "mine", "SKILL.md"), skill("mine"));
  const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness() }));
  runtimes.push(runtime as never);
  const run = <A, E>(effect: Effect.Effect<A, E, Engine | Reactor | SqlClient.SqlClient | ProfileSkills>) => runtime.runPromise(effect);
  const dispatch = (c: Command) => run(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  // The user allows every skill proposal.
  await run(
    Effect.flatMap(Engine, (engine) =>
      engine.react(({ event: e }) =>
        e.type === "skill.proposed"
          ? engine
              .dispatch({
                type: "approval.respond",
                commandId: id<CommandId>(),
                threadId: e.threadId,
                requestId: e.requestId,
                resolution: { decision: "allow" },
              })
              .pipe(Effect.ignore)
          : Effect.void,
      ),
    ),
  );
  const threadId = id<ThreadId>();
  await dispatch({
    type: "thread.create",
    commandId: id<CommandId>(),
    threadId,
    projectPath: "/work/app",
    route: { harness: "fake", model: "fake", effort: "low" },
  });
  const turn = async (text: string) => {
    await dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId: id<TurnId>(), text, mode: "build" });
    await run(Effect.flatMap(Reactor, (r) => r.drain));
    return (await run(loadThreadView(threadId)))?.turns.at(-1)?.items ?? [];
  };
  const toolResult = (items: readonly Item[]) => items.find((i) => i.kind === "tool.result");
  const create = (name: string) => turn(`tool skill_manage ${JSON.stringify({ action: "create", name, content: skill(name) })}`);
  const sweep = async (now: number) => {
    await run(curateSkills(now));
    await run(Effect.flatMap(Reactor, (r) => r.drain));
  };
  const states = async () =>
    Object.fromEntries(
      (await run(loadSkillsView)).folders.flatMap((f) => f.skills.map((s) => [s.name, `${f.source}:${s.curation?.state ?? "user"}`])),
    );
  const changes = async () =>
    (
      await run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql<{ payload: string }>`select payload from events where type = 'skill.state.changed' order by seq`,
        ),
      )
    ).map((r) => {
      const { skill, from, to, by } = JSON.parse(r.payload) as Record<string, string>;
      return `${skill} ${from}→${to} by ${by}`;
    });

  expect(toolResult(await create("deploy-notes"))?.isError).toBe(false);
  expect(toolResult(await create("release-steps"))?.isError).toBe(false);

  // Ten days on, the agent loads one of them through Claude Code's Skill tool.
  setSystemTime(new Date(t0 + 10 * day));
  await turn("skill verdandi:release-steps");

  await sweep(t0 + 15 * day);
  expect(await states()).toEqual({ "deploy-notes": "profile:stale", "release-steps": "profile:active", mine: "profile:user" });

  await sweep(t0 + 31 * day);
  expect(await states()).toEqual({ "deploy-notes": "archived:archived", "release-steps": "profile:stale", mine: "profile:user" });
  // Out of the folder Claude Code loads, never deleted.
  expect(existsSync(join(skills, "deploy-notes"))).toBe(false);
  expect(readFileSync(join(home, "skills-archive", "deploy-notes", "SKILL.md"), "utf8")).toBe(skill("deploy-notes"));
  expect(readFileSync(join(skills, "mine", "SKILL.md"), "utf8")).toBe(skill("mine"));
  // Another sweep has nothing more to do.
  await sweep(t0 + 31 * day);
  expect(await changes()).toEqual([
    "deploy-notes active→stale by sweep",
    "deploy-notes stale→archived by sweep",
    "release-steps active→stale by sweep",
  ]);

  // The agent can't create a skill over an archived one's name.
  const taken = toolResult(await create("deploy-notes"));
  expect(taken).toMatchObject({ isError: true, content: expect.stringContaining("archived") });

  // The user restores it: back where Claude Code loads it, its clock started again.
  setSystemTime(new Date(t0 + 31 * day));
  await dispatch({ type: "skill.restore", commandId: id<CommandId>(), threadId, skill: "deploy-notes" });
  await run(Effect.flatMap(Reactor, (r) => r.drain));
  expect(readFileSync(join(skills, "deploy-notes", "SKILL.md"), "utf8")).toBe(skill("deploy-notes"));
  expect(existsSync(join(home, "skills-archive", "deploy-notes"))).toBe(false);
  await sweep(t0 + 39 * day);
  expect(await states()).toEqual({ "deploy-notes": "profile:active", "release-steps": "profile:stale", mine: "profile:user" });
  expect((await changes()).at(-1)).toBe("deploy-notes archived→active by user");

  // Only an archived skill can be restored.
  const again = run(
    Effect.flip(
      Effect.flatMap(Engine, (e) => e.dispatch({ type: "skill.restore", commandId: id<CommandId>(), threadId, skill: "deploy-notes" })),
    ),
  );
  expect(await again).toMatchObject({ reason: "SkillNotArchived" });
});

test("the migration rebuilds the skills Verdandi created from the log, with their last use, so they're curated too", async () => {
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  setSystemTime(new Date(t0));
  const home = makeTempHome();
  dirs.push(home);
  mkdirSync(join(home, "skills", "mine"), { recursive: true });
  writeFileSync(join(home, "skills", "mine", "SKILL.md"), skill("mine"));
  const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness() }));
  runtimes.push(runtime as never);
  const run = <A, E>(effect: Effect.Effect<A, E, Engine | Reactor | SqlClient.SqlClient | ProfileSkills>) => runtime.runPromise(effect);
  await run(
    Effect.flatMap(Engine, (engine) =>
      engine.react(({ event: e }) =>
        e.type === "skill.proposed"
          ? engine
              .dispatch({
                type: "approval.respond",
                commandId: id<CommandId>(),
                threadId: e.threadId,
                requestId: e.requestId,
                resolution: { decision: "allow" },
              })
              .pipe(Effect.ignore)
          : Effect.void,
      ),
    ),
  );
  const threadId = id<ThreadId>();
  const route = { harness: "fake", model: "fake", effort: "low" } as const;
  await run(
    Effect.flatMap(Engine, (e) =>
      e.dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId, projectPath: "/work/app", route }),
    ),
  );
  const turn = async (text: string) => {
    await run(
      Effect.flatMap(Engine, (e) =>
        e.dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId: id<TurnId>(), text, mode: "build" }),
      ),
    );
    await run(Effect.flatMap(Reactor, (r) => r.drain));
  };
  const manage = (args: object) => turn(`tool skill_manage ${JSON.stringify(args)}`);
  // One skill used later, one used under its bare name, one deleted, and a use of a skill before it was created.
  await turn("skill verdandi:deploy-notes");
  await manage({ action: "create", name: "deploy-notes", content: skill("deploy-notes") });
  await manage({ action: "create", name: "release-steps", content: skill("release-steps") });
  await manage({ action: "create", name: "gone", content: skill("gone") });
  await manage({ action: "delete", name: "gone" });
  setSystemTime(new Date(t0 + 10 * day));
  await turn("skill verdandi:release-steps");
  setSystemTime(new Date(t0 + 20 * day));
  await turn("skill deploy-notes");

  const rows = Effect.flatMap(SqlClient.SqlClient, (sql) => sql`select * from skills order by name`);
  const live = await run(rows);
  expect(live.map((r) => r.name)).toEqual(["deploy-notes", "release-steps"]);
  // A database from before skills had a state: the table is rebuilt from the events alone.
  const rebuilt = await run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`drop table skills`;
      yield* migrations["23_skills"];
      return yield* rows;
    }),
  );
  expect(rebuilt).toEqual(live);

  await run(curateSkills(t0 + 31 * day));
  await run(Effect.flatMap(Reactor, (r) => r.drain));
  const states = (await run(loadSkillsView)).folders.flatMap((f) =>
    f.skills.map((s) => `${f.source} ${s.name} ${s.curation?.state ?? "user"}`),
  );
  // Used on day 20 and day 10: one still active, one stale. The hand-written one has no curation, and the deleted one
  // was archived, not removed, with no curation either.
  expect(states).toEqual(["profile deploy-notes active", "profile mine user", "profile release-steps stale", "archived gone user"]);
});

test("a pinned skill Verdandi created stays active however long it goes unused, and the sweep can't archive it", async () => {
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  setSystemTime(new Date(t0));
  const home = makeTempHome();
  dirs.push(home);
  const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness() }));
  runtimes.push(runtime as never);
  const run = <A, E>(effect: Effect.Effect<A, E, Engine | Reactor | SqlClient.SqlClient | ProfileSkills>) => runtime.runPromise(effect);
  const dispatch = (c: Command) => run(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  await run(
    Effect.flatMap(Engine, (engine) =>
      engine.react(({ event: e }) =>
        e.type === "skill.proposed"
          ? engine
              .dispatch({
                type: "approval.respond",
                commandId: id<CommandId>(),
                threadId: e.threadId,
                requestId: e.requestId,
                resolution: { decision: "allow" },
              })
              .pipe(Effect.ignore)
          : Effect.void,
      ),
    ),
  );
  const threadId = id<ThreadId>();
  const route = { harness: "fake", model: "fake", effort: "low" } as const;
  await dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId, projectPath: "/work/app", route });
  const text = `tool skill_manage ${JSON.stringify({ action: "create", name: "deploy-notes", content: skill("deploy-notes") })}`;
  await dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId: id<TurnId>(), text, mode: "build" });
  await run(Effect.flatMap(Reactor, (r) => r.drain));
  await dispatch({ type: "skill.pin", commandId: id<CommandId>(), skill: "deploy-notes" });

  await run(curateSkills(t0 + 40 * day));
  await run(Effect.flatMap(Reactor, (r) => r.drain));
  const [pinned] = (await run(loadSkillsView)).folders[0]?.skills ?? [];
  expect(pinned).toMatchObject({ name: "deploy-notes", pinned: true, curation: { state: "active" } });
  expect(existsSync(join(home, "skills", "deploy-notes", "SKILL.md"))).toBe(true);
  // A sweep that read the skill before the pin committed is refused by the decider too.
  const usedAt = pinned?.curation?.usedAt ?? "";
  await dispatch({ type: "skill.curate", commandId: id<CommandId>(), threadId, skill: "deploy-notes", to: "archived", usedAt });
  expect((await run(loadSkillsView)).folders[0]?.skills[0]?.curation?.state).toBe("active");
});
