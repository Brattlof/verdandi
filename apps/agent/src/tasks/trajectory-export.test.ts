import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Command, type CommandId, RoutingExample, type ThreadId, type TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime, Schema } from "effect";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { Reactor } from "../event-store/reactor.ts";
import { exportTrajectories } from "./trajectory-export.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempHome(d);
});
const tempDir = () => {
  const d = makeTempHome();
  dirs.push(d);
  return d;
};

const route = { harness: "fake", model: "fake", effort: "low" } as const;
const secret = `sk-${"x".repeat(24)}`;
const excluded = resolve("/work/client");

/** Records a two-turn task in a project and a turn in an excluded one, and returns verdandid's home and the first project. */
const record = async () => {
  const project = tempDir();
  const home = tempDir();
  writeFileSync(join(home, "trajectories.yaml"), `excludeProjects: [${excluded}]\n`);
  const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness() }));
  const dispatch = (c: Command) => Effect.flatMap(Engine, (engine) => engine.dispatch(c));
  const thread = (projectPath: string, texts: string[]) =>
    Effect.gen(function* () {
      const threadId = crypto.randomUUID() as ThreadId;
      yield* dispatch({ type: "thread.create", commandId: crypto.randomUUID() as CommandId, threadId, projectPath, route });
      const turnIds: TurnId[] = [];
      for (const text of texts) {
        const turnId = crypto.randomUUID() as TurnId;
        turnIds.push(turnId);
        yield* dispatch({ type: "turn.send", commandId: crypto.randomUUID() as CommandId, threadId, turnId, text, mode: "build" });
        yield* (yield* Reactor).drain;
      }
      return { threadId, taskId: turnIds[0] };
    });
  const task = await runtime.runPromise(Effect.andThen(thread(excluded, ["hi"]), thread(project, [`remember ${secret}`, "edit a.txt"])));
  await runtime.dispose();
  // As if saved before the redactor knew this secret's shape: export masks it again.
  const db = new Database(join(home, "verdandi.db"));
  db.run("update trajectories set payload = replace(payload, '[REDACTED]', ?)", [secret]);
  // As if the outcome was written before ratings and escalation triggers: it exports as the current version.
  db.run("update task_outcomes set payload = json_remove(json_set(payload, '$.v', 1), '$.triggers', '$.rating')");
  db.close();
  return { home, project, ...task };
};

test("exports a task as a chat conversation and a routing example, masking secrets and leaving out excluded projects", async () => {
  const { home, project, threadId, taskId } = await record();
  const edited = resolve(project, "a.txt");

  const jsonl = exportTrajectories(home, { format: "jsonl" });
  expect(jsonl.excluded).toBe(1);
  expect(jsonl.lines.join("")).not.toContain(secret);
  expect(jsonl.lines.map((l) => JSON.parse(l))).toEqual([
    {
      messages: [
        { role: "user", content: "remember [REDACTED]" },
        { role: "assistant", content: "echo: remember [REDACTED]" },
        { role: "user", content: "edit a.txt" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "fake-edit", type: "function", function: { name: "Edit", arguments: JSON.stringify({ file_path: edited }) } }],
        },
        { role: "tool", tool_call_id: "fake-edit", content: "ok" },
        { role: "assistant", content: `edited ${edited}` },
      ],
      metadata: { v: 1, taskId, threadId, projectId: expect.any(String), route, status: "success" },
    },
  ]);

  const routing = exportTrajectories(home, { format: "routing" });
  expect(routing.excluded).toBe(1);
  expect(routing.lines.join("")).not.toContain(secret);
  const decodeRouting = Schema.decodeUnknownSync(Schema.fromJsonString(RoutingExample));
  expect(routing.lines.map((l) => decodeRouting(l.trimEnd()))).toEqual([
    expect.objectContaining({
      v: 1,
      taskId,
      threadId,
      text: "remember [REDACTED]",
      mode: "build",
      images: 0,
      route,
      decision: expect.objectContaining({ source: "pin" }),
      outcome: expect.objectContaining({ v: 3, status: "completed", turns: 2, triggers: [] }),
      costUsd: 0.02,
    }),
  ]);

  expect(exportTrajectories(home, { format: "routing", since: new Date("2999-01-01") }).lines).toEqual([]);
});

test("a broken exclusion file fails the export, naming the file and the key", async () => {
  const home = tempDir();
  const file = join(home, "trajectories.yaml");
  writeFileSync(file, "excludeProjects: /work/client\n");
  expect(() => exportTrajectories(home, { format: "jsonl" })).toThrow(file);
  expect(() => exportTrajectories(home, { format: "jsonl" })).toThrow("excludeProjects");
});
