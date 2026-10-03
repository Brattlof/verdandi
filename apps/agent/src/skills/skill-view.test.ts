import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, Item, ThreadId, TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { loadThreadView } from "../event-store/projector.ts";
import { Reactor } from "../event-store/reactor.ts";
import { loadSkillsView } from "./skill-curation.ts";
import { skillUsed } from "./skills.ts";

const dirs: string[] = [];
const runtimes: ManagedRuntime.ManagedRuntime<unknown, unknown>[] = [];
afterEach(async () => {
  setSystemTime();
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const d of dirs.splice(0)) removeTempHome(d);
});
let n = 0;
const id = <T>() => `view-${++n}` as T;
const day = 24 * 60 * 60 * 1000;
const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nSteps.\n`;

const setup = async () => {
  const home = makeTempHome();
  dirs.push(home);
  // A skill the user wrote by hand, beside the one the agent creates.
  mkdirSync(join(home, "skills", "mine"), { recursive: true });
  writeFileSync(join(home, "skills", "mine", "SKILL.md"), skill("mine", "The user's own release checklist."));
  const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness() }));
  runtimes.push(runtime as never);
  const dispatch = (c: Command) => runtime.runPromise(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  // The user allows every skill proposal.
  await runtime.runPromise(
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
    projectPath: home,
    route: { harness: "fake", model: "fake", effort: "low" },
  });
  /** Runs `tool <name> <args>` on the fake harness and returns the tool's result. */
  const call = async (name: string, args: Record<string, unknown>) => {
    await dispatch({
      type: "turn.send",
      commandId: id<CommandId>(),
      threadId,
      turnId: id<TurnId>(),
      text: `tool ${name} ${JSON.stringify(args)}`,
      mode: "build",
    });
    await runtime.runPromise(Effect.flatMap(Reactor, (r) => r.drain));
    const items = (await runtime.runPromise(loadThreadView(threadId)))?.turns.at(-1)?.items ?? [];
    return items.find((i): i is Extract<Item, { kind: "tool.result" }> => i.kind === "tool.result");
  };
  const usedAt = async (name: string) =>
    (await runtime.runPromise(loadSkillsView)).folders.flatMap((f) => f.skills).find((s) => s.name === name)?.curation?.usedAt;
  return { call, usedAt };
};

test("skills_list and skill_view show a skill and its files, refuse a path out of it, and viewing counts as using it", async () => {
  const t0 = Date.parse("2026-01-01T00:00:00.000Z");
  setSystemTime(new Date(t0));
  const { call, usedAt } = await setup();
  await call("skill_manage", { action: "create", name: "deploy-notes", content: skill("deploy-notes", "How this user deploys.") });
  await call("skill_manage", { action: "write_file", name: "deploy-notes", path: "references/hosts.md", content: "staging: s1\n" });

  expect((await call("skills_list", {}))?.content).toBe(
    "- deploy-notes: How this user deploys.\n- mine: The user's own release checklist.",
  );
  expect((await call("skills_list", { query: "release" }))?.content).toBe("- mine: The user's own release checklist.");

  setSystemTime(new Date(t0 + 10 * day));
  const viewed = await call("skill_view", { name: "deploy-notes" });
  expect(viewed?.isError).toBe(false);
  expect(viewed?.content).toContain("description: How this user deploys.");
  expect(viewed?.content).toContain("- references/hosts.md");
  // Viewing a skill Verdandi created moves its last use, so curation keeps it active.
  expect(await usedAt("deploy-notes")).toBe(new Date(t0 + 10 * day).toISOString());

  expect((await call("skill_view", { name: "deploy-notes", path: "references/hosts.md" }))?.content).toBe("staging: s1\n");
  const out = await call("skill_view", { name: "deploy-notes", path: "../mine/SKILL.md" });
  expect(out?.isError).toBe(true);
  expect(out?.content).toContain("isn't a file path inside the skill");
  expect((await call("skill_view", { name: "nope" }))?.content).toContain("There's no skill named nope.");
});

test("a skill counts as used through Claude Code's Skill tool or Verdandi's skill_view, under either harness's name for it", () => {
  const call = (name: string, input: unknown): Item => ({ kind: "tool.call", toolUseId: "t", name, input });
  expect(skillUsed(call("Skill", { skill: "verdandi:deploy-notes" }))).toBe("deploy-notes");
  expect(skillUsed(call("skill_view", { name: "deploy-notes", path: "references/hosts.md" }))).toBe("deploy-notes");
  expect(skillUsed(call("mcp__verdandi__skill_view", { name: "deploy-notes" }))).toBe("deploy-notes");
  expect(skillUsed(call("skills_list", { query: "deploy" }))).toBeUndefined();
  expect(skillUsed(call("constructor", { name: "deploy-notes" }))).toBeUndefined();
});
