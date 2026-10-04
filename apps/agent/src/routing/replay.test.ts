import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, TaskId, ThreadId, TurnId } from "@verdandi/contracts";
import { loadPolicy } from "@verdandi/router";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime, Result } from "effect";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { Reactor } from "../event-store/reactor.ts";
import { loadSavedTasks, replay, replayTask, type SavedTask } from "./replay.ts";
import { replayText } from "./routing-cli.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempHome(d);
});
const tempDir = () => {
  const d = makeTempHome();
  dirs.push(d);
  return d;
};

const SEARCH = "Where is the auth middleware?";
const DEBUG = "Why does the upload keep failing? Investigate the root cause.";
const fakeTargets = `
targets:
  small: { harness: fake, provider: fake, model: fake-small }
  large: { harness: fake, provider: fake, model: fake-large }
`;
const current = `${fakeTargets}routes:
  ask.search: { prefer: [small], effort: low }
  debug.investigate: { prefer: [large], effort: high }
`;
const proposed = `${fakeTargets}routes:
  ask.search: { prefer: [large], effort: high }
  debug.investigate: { prefer: [large], effort: high }
`;

/** Runs two routed fake-harness tasks in a project under `current`, and returns verdandid's home. */
const recordTasks = async () => {
  const projectPath = tempDir();
  mkdirSync(join(projectPath, ".verdandi"));
  writeFileSync(join(projectPath, ".verdandi", "routing.yaml"), current);
  const home = tempDir();
  const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness() }));
  const dispatch = (c: Command) => Effect.flatMap(Engine, (engine) => engine.dispatch(c));
  const task = (text: string) =>
    Effect.gen(function* () {
      const threadId = crypto.randomUUID() as ThreadId;
      yield* dispatch({ type: "thread.create", commandId: crypto.randomUUID() as CommandId, threadId, projectPath });
      const turnId = crypto.randomUUID() as TurnId;
      yield* dispatch({ type: "turn.send", commandId: crypto.randomUUID() as CommandId, threadId, turnId, text, mode: "build" });
      yield* (yield* Reactor).drain;
    });
  await runtime.runPromise(Effect.andThen(task(SEARCH), task(DEBUG)));
  const whileRunning = loadSavedTasks(home); // verdandid still has the database open
  await runtime.dispose();
  return { home, projectPath, whileRunning };
};

test("replaying saved tasks under a proposed policy lists the routes that change, from their recorded inputs", async () => {
  const { home, whileRunning } = await recordTasks();
  const tasks = loadSavedTasks(home);
  expect(whileRunning).toEqual(tasks);
  expect(tasks.map((t) => [t.text, t.route.model, t.inputs?.harnesses])).toEqual([
    [SEARCH, "fake-small", ["fake"]],
    [DEBUG, "fake-large", ["fake"]],
  ]);

  expect(replay(tasks).tasks.map((t) => t.to.model)).toEqual(["fake-small", "fake-large"]); // the project's own policy, unchanged

  const file = join(tempDir(), "proposed routing.yaml");
  writeFileSync(file, proposed);
  const result = replay(tasks, file);
  expect(result.assumed).toBeUndefined();
  expect(result.tasks.map((t) => [t.task.route.model, t.to.model, t.to.effort])).toEqual([
    ["fake-small", "fake-large", "high"],
    ["fake-large", "fake-large", "high"],
  ]);
  const text = replayText(result);
  expect(text).toContain("1 would route differently:");
  expect(text).toContain("ask.search: fake fake-small low → fake fake-large high");
  expect(text).toContain("Estimated cost change: +$0.0000 over 1 changed task. An estimate");
});

const usage = {
  model: "haiku",
  accessMode: "subscription",
  inputTokens: 1_000_000,
  outputTokens: 100_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 1,
} as const;
const saved = (inputs: SavedTask["inputs"]): SavedTask => ({
  taskId: "00000000-0000-4000-8000-000000000001" as TaskId,
  projectPath: "C:/Users/a b/repo",
  text: SEARCH,
  mode: "build",
  images: 0,
  route: { harness: "claude-code", model: "haiku", effort: "low" },
  taskClass: "ask.search",
  inputs,
  pinnedBefore: false,
  usage: [usage],
});

test("prices a changed task's recorded tokens at both targets' list prices, and replays old tasks on assumed inputs", () => {
  const route = { harness: "claude-code", model: "haiku", effort: "low" } as const;
  const inputs = { route, pinned: false, budgetMode: null, warm: false, cachedTokens: 0, harnesses: ["claude-code"] } as const;
  const opus = loadPolicy([{ source: "proposed.yaml", data: { routes: { "ask.search": { prefer: ["cc-opus"] } } } }]);
  const replayed = replayTask(saved(inputs), { policy: Result.succeed(opus), builtIn: loadPolicy() });
  const t = Result.getOrThrow(replayed);
  expect(t.to).toMatchObject({ model: "opus", effort: "low" });
  // 1M input and 0.1M output tokens: haiku at $1/$5 per MTok, opus at $4/$20 (the built-in catalog).
  expect(t.costFrom).toBeCloseTo(1.5);
  expect(t.costTo).toBeCloseTo(6);
  expect(replayText({ policy: "proposed.yaml", tasks: [t], failed: [], assumed: undefined })).toContain("Estimated cost change: +$4.5000");

  const old = replay([saved(null)]);
  expect(old.tasks[0]?.to.model).toBe("haiku");
  expect(replayText(old)).toContain("replayed assuming no warm session, the policy's budget mode, no routing memory");
});

test("a task pinned with @name replays to its pin, whatever the policy says", () => {
  const route = { harness: "claude-code", model: "fable", effort: "low" } as const;
  const inputs = { route, pinned: false, budgetMode: null, warm: false, cachedTokens: 0, harnesses: ["claude-code"], at: "fable" } as const;
  const t = Result.getOrThrow(replayTask({ ...saved(inputs), route }, { policy: Result.succeed(loadPolicy()), builtIn: loadPolicy() }));
  expect(t.to).toEqual(route);
  expect(t.reason).toBe("Pinned with @fable.");
});

test("a broken proposed policy fails naming the file and the key", () => {
  const file = join(tempDir(), "broken.yaml");
  writeFileSync(file, "routes:\n  ask.search: { effort: extreme }\n");
  expect(() => replay([saved(null)], file)).toThrow(file);
  expect(() => replay([saved(null)], file)).toThrow(/\["routes"\]\["ask\.search"\]\["effort"\]/);
});

test("a proposed policy may route to a model in the profile's providers.yaml", () => {
  const file = join(tempDir(), "local.yaml");
  writeFileSync(
    file,
    "targets:\n  qwen: { harness: native, provider: ollama, model: qwen3:8b }\nroutes:\n  ask.search: { prefer: [qwen] }\n",
  );
  const qwen = {
    harness: "native",
    provider: "ollama",
    model: "qwen3:8b",
    access: "local",
    tier: "S",
    context: 32768,
    vision: false,
    efforts: [],
    price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as const;
  expect(() => replay([saved(null)], file)).toThrow("qwen3:8b");
  expect(replay([saved(null)], file, [qwen]).failed).toEqual([]);
});
