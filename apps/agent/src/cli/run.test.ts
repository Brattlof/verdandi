import { afterAll, afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandId, ThreadId, TurnId } from "@verdandi/contracts";
import { git, gitHeavyTimeout, makeFakeHarness, makeTempHome, makeTempRepo, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { Engine } from "../event-store/engine.ts";
import { type ServerFile, serverFile } from "../home/home.ts";
import { ServerInfo, ServerLayer } from "../rpc/server.ts";
import { exitCodes, type RunResult } from "./run.ts";

setDefaultTimeout(gitHeavyTimeout);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
/** The project folder each run starts in. */
const folder = makeTempHome();
afterAll(() => removeTempHome(folder));

/** Each test spawns the CLI, which takes a second or more on a cold Windows runner: a hang guard, not a wait. */
const spawnTimeout = 30_000;

/**
 * Trusts `commands` in `project`, as the user allowing them in an earlier chat would: raised and allowed on a turn of a
 * thread of its own, which is then interrupted, so nothing runs.
 */
const trustCommands = (engine: Engine["Service"], project: string, commands: readonly string[]) =>
  Effect.gen(function* () {
    const uuid = <T>() => crypto.randomUUID() as T;
    const [threadId, turnId, requestId] = [uuid<ThreadId>(), uuid<TurnId>(), uuid<CommandId>()];
    const projectPath = realpathSync.native(project);
    yield* engine.dispatch({
      type: "thread.create",
      commandId: uuid(),
      threadId,
      projectPath,
      route: { harness: "fake", model: "fake", effort: "low" },
    });
    yield* engine.dispatch({ type: "turn.send", commandId: uuid(), threadId, turnId, text: "hang", mode: "build" });
    yield* engine.dispatch({ type: "commands.trust.request", commandId: requestId, threadId, turnId, purpose: "verifiers", commands });
    yield* engine.dispatch({ type: "approval.respond", commandId: uuid(), threadId, requestId, resolution: { decision: "allow" } });
    yield* engine.dispatch({ type: "turn.interrupt", commandId: uuid(), threadId, turnId });
  });

/**
 * A temp home with verdandid running on the fake harness and its server.json written, like `verdandi start`, which
 * trusts each of `trusted`'s projects' verifiers.
 */
const startServer = async (...trusted: readonly { readonly project: string; readonly commands: readonly string[] }[]) => {
  const home = makeTempHome();
  cleanups.push(async () => removeTempHome(home));
  const runtime = ManagedRuntime.make(ServerLayer(home, { fake: makeFakeHarness() }));
  cleanups.push(() => runtime.dispose());
  const info = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ServerInfo;
    }),
  );
  await runtime.runPromise(
    Effect.flatMap(Engine, (engine) => Effect.forEach(trusted, ({ project, commands }) => trustCommands(engine, project, commands))),
  );
  writeFileSync(serverFile(home), JSON.stringify({ ...info, pid: process.pid } satisfies ServerFile));
  return { home, runtime };
};

/** Runs `verdandi run` as a user would, in the project folder; `started` sees the process before it exits. */
const verdandiRun = async (home: string, args: readonly string[], started?: (proc: Bun.Subprocess) => void) => {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "bin.ts"), "run", "--home", home, ...args], {
    cwd: folder,
    stdout: "pipe",
    stderr: "pipe",
  });
  started?.(proc);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
};

const pinned = ["--route", "fake/fake/low"];

test(
  "runs a task headless, prints the reply and exits 0",
  async () => {
    const { home } = await startServer();
    const { stdout, stderr, code } = await verdandiRun(home, [...pinned, "hello", "there"]);
    expect(stdout).toBe("echo: hello there\n");
    expect(stderr).toContain("[completed on fake low via fake");
    expect(code).toBe(exitCodes.completed);
  },
  spawnTimeout,
);

test(
  "a turn that asks for approval fails fast, naming the request and how to answer it, and leaves the thread free",
  async () => {
    const { home } = await startServer();
    const asked = await verdandiRun(home, [...pinned, "--json", "approve"]);
    const result = JSON.parse(asked.stdout) as RunResult;
    expect(asked.code).toBe(exitCodes.request);
    expect(result.status).toBe("request");
    expect(asked.stderr).toContain('The agent stopped for approval to use Edit {"file_path":"a.txt"}');
    expect(asked.stderr).toContain(`verdandi chat --thread ${result.threadId}`);
    expect(asked.stderr).toContain("--deny-requests");
    // The run interrupted its turn, so the thread takes the next one.
    const next = await verdandiRun(home, ["--thread", result.threadId, "again"]);
    expect(next.stdout).toBe("echo: again\n");
    expect(next.code).toBe(exitCodes.completed);
  },
  spawnTimeout,
);

test(
  "--deny-requests denies what the agent asks and lets it finish",
  async () => {
    const { home } = await startServer();
    const { stdout, stderr, code } = await verdandiRun(home, [...pinned, "--deny-requests", "approve"]);
    expect(stdout).toBe("left a.txt alone\n");
    expect(stderr).toContain("[denied approval to use Edit");
    expect(code).toBe(exitCodes.completed);
  },
  spawnTimeout,
);

test(
  "--json prints one object with the turn's status, route, cost and reply",
  async () => {
    const { home } = await startServer();
    const done = await verdandiRun(home, [...pinned, "--json", "hello"]);
    expect(done.code).toBe(exitCodes.completed);
    expect(JSON.parse(done.stdout)).toMatchObject({
      status: "completed",
      route: { harness: "fake", model: "fake", effort: "low" },
      cost: { meteredUsd: 0, subscriptionUsd: 0.01 },
      reply: "echo: hello",
    });
    expect((JSON.parse(done.stdout) as RunResult).taskId).toBeString();
    const failed = await verdandiRun(home, [...pinned, "--json", "fail"]);
    expect(JSON.parse(failed.stdout)).toMatchObject({ status: "failed", error: "fake failure" });
    expect(failed.code).toBe(exitCodes.failed);
  },
  spawnTimeout,
);

test(
  "a turn whose verifier fails exits as failed, with the verifier's output",
  async () => {
    // Made first, so it's removed after verdandid stops: the reactor checkpoints it once the turn has ended.
    const project = makeTempHome();
    cleanups.push(async () => removeTempHome(project));
    const { home } = await startServer({ project, commands: ["echo broken && exit 1"] });
    mkdirSync(join(project, ".verdandi"));
    writeFileSync(join(project, ".verdandi", "routing.yaml"), 'escalation: { verifiers: ["echo broken && exit 1"] }');
    const { stderr, code } = await verdandiRun(home, [...pinned, "--project", project, "edit", "a.txt"]);
    expect(stderr).toContain("The verifier echo broken && exit 1 failed (exit 1):\nbroken");
    expect(code).toBe(exitCodes.failed);
  },
  spawnTimeout,
);

test(
  "a project whose verifiers aren't trusted stops the run as a request, naming the commands and how to answer",
  async () => {
    const project = makeTempHome();
    cleanups.push(async () => removeTempHome(project));
    const { home } = await startServer();
    mkdirSync(join(project, ".verdandi"));
    writeFileSync(join(project, ".verdandi", "routing.yaml"), 'escalation: { verifiers: ["echo checked"] }');
    const { stdout, stderr, code } = await verdandiRun(home, [...pinned, "--project", project, "--json", "edit", "a.txt"]);
    const result = JSON.parse(stdout) as RunResult;
    expect(code).toBe(exitCodes.request);
    expect(stderr).toContain(
      "Verdandi stopped for approval to run the project's verifiers from .verdandi/routing.yaml: `echo checked`, which this project hasn't trusted",
    );
    expect(stderr).toContain(`verdandi chat --thread ${result.threadId}`);
  },
  spawnTimeout,
);

/** A project whose policy routes every task to the fake model at medium effort, with `verifier` as its verifier. */
const routedProject = (verifier: string) => {
  const project = makeTempHome();
  cleanups.push(async () => removeTempHome(project));
  mkdirSync(join(project, ".verdandi"));
  // Fails the first time it runs in a folder and passes after, like a test the agent's fix makes pass.
  const flakyOnce = `const fs = require("fs"); if (fs.existsSync("fixed")) process.exit(0); fs.writeFileSync("fixed", ""); process.exit(1);`;
  writeFileSync(join(project, "check.js"), flakyOnce);
  writeFileSync(
    join(project, ".verdandi", "routing.yaml"),
    [
      "minConfidence: 1",
      "targets:",
      "  mid: { harness: fake, provider: fake, model: fake }",
      "fallback: { prefer: [mid], effort: medium }",
      `escalation: { verifiers: ${JSON.stringify([verifier])} }`,
    ].join("\n"),
  );
  return project;
};

test(
  "follows the task through Verdandi's follow-up turn when a verifier fails and the escalation fixes it",
  async () => {
    const verifier = `"${process.execPath}" check.js`;
    const project = routedProject(verifier);
    const { home } = await startServer({ project, commands: [verifier] });
    const { stdout, stderr, code } = await verdandiRun(home, ["--project", project, "edit", "a.txt"]);
    const edited = `edited ${join(realpathSync.native(project), "a.txt")}\n`;
    expect(stdout).toBe(edited + edited);
    expect(stderr).toContain("[escalated to fake high:");
    expect(stderr).toContain("[completed on fake high via fake");
    expect(code).toBe(exitCodes.completed);
  },
  spawnTimeout,
);

test(
  "an escalation that stops to ask exits as failed naming the thread, and --json reports every step and turn's cost",
  async () => {
    const project = routedProject("exit 1");
    const { home } = await startServer({ project, commands: ["exit 1"] });
    const { stdout, stderr, code } = await verdandiRun(home, ["--project", project, "--json", "edit", "a.txt"]);
    const result = JSON.parse(stdout) as RunResult;
    expect(code).toBe(exitCodes.failed);
    expect(result).toMatchObject({
      status: "failed",
      route: { model: "fake", effort: "high" },
      cost: { subscriptionUsd: 0.02 },
      escalations: [
        { step: "effort", from: { effort: "medium" }, to: { effort: "high" }, reason: expect.stringContaining("goes on at high effort") },
        { step: "ask", from: { effort: "high" }, reason: expect.stringContaining("leaves the next step to you") },
      ],
    });
    expect(result.escalations[1]).not.toHaveProperty("to");
    expect(stderr).toContain("leaves the next step to you");
    expect(stderr).toContain(`verdandi chat --thread ${result.threadId}`);
  },
  spawnTimeout,
);

test(
  "follows the turn on when denying its plan escalates the task inside it",
  async () => {
    const project = routedProject("exit 1");
    const { home } = await startServer();
    const { stdout, stderr, code } = await verdandiRun(home, ["--project", project, "--mode", "plan", "--deny-requests", "--json", "plan"]);
    const result = JSON.parse(stdout) as RunResult;
    expect(code).toBe(exitCodes.completed);
    expect(result).toMatchObject({
      status: "completed",
      route: { effort: "high" },
      escalations: [{ trigger: "plan-rejected", step: "effort", from: { effort: "medium" }, to: { effort: "high" } }],
    });
    expect(result.reply).toBe("kept planning");
    expect(stderr).toContain("[denied approval of its plan");
  },
  spawnTimeout,
);

test(
  "follows the task when its agent reports it is blocked, whatever set off the escalation",
  async () => {
    const project = routedProject("exit 1");
    const { home } = await startServer({ project, commands: ["exit 1"] });
    const { stdout, code } = await verdandiRun(home, ["--project", project, "--json", 'tool report_blocked {"reason":"stuck"}']);
    const result = JSON.parse(stdout) as RunResult;
    expect(code).toBe(exitCodes.completed);
    expect(result).toMatchObject({ status: "completed", escalations: [{ trigger: "blocked", step: "effort", to: { effort: "high" } }] });
    expect(result.reply).toStartWith("called report_blocked\necho: You reported that you're blocked on this task.");
  },
  spawnTimeout,
);

test(
  "follows the task when the same tool error repeats, exiting with the escalated turn's code",
  async () => {
    const project = makeTempHome();
    cleanups.push(async () => removeTempHome(project));
    mkdirSync(join(project, ".verdandi"));
    writeFileSync(
      join(project, ".verdandi", "routing.yaml"),
      [
        "minConfidence: 1",
        "targets:",
        "  mid: { harness: fake, provider: fake, model: fake }",
        "fallback: { prefer: [mid], effort: medium }",
        "escalation: { repeatedErrors: 2 }",
      ].join("\n"),
    );
    const { home } = await startServer();
    // The first failure is one short of the policy's count, so that run ends with its turn.
    const first = JSON.parse((await verdandiRun(home, ["--project", project, "--json", "tool missing {}"])).stdout) as RunResult;
    expect(first).toMatchObject({ status: "completed", escalations: [] });
    const { stdout, code } = await verdandiRun(home, ["--thread", first.threadId, "--json", "tool missing {}"]);
    const result = JSON.parse(stdout) as RunResult;
    expect(code).toBe(exitCodes.completed);
    expect(result).toMatchObject({
      status: "completed",
      route: { effort: "high" },
      escalations: [{ trigger: "repeated-error", step: "effort", from: { effort: "medium" }, to: { effort: "high" } }],
    });
    expect(result.reply).toContain("There's no Verdandi tool missing.");
  },
  spawnTimeout,
);

test(
  "stops waiting for Verdandi's decision once the thread is reverted, saying why",
  async () => {
    const project = routedProject("exit 1");
    const { home, runtime } = await startServer({ project, commands: ["exit 1"] });
    const first = JSON.parse((await verdandiRun(home, ["--project", project, "--json", "hello"])).stdout) as RunResult;
    // Reverted the moment the run's turn completes, before the reactor asks whether to escalate its failed verifier.
    await runtime.runPromise(
      Effect.flatMap(Engine, (engine) =>
        engine.react(({ event }) =>
          event.type === "turn.completed" && event.turnId !== first.turnId
            ? engine
                .dispatch({
                  type: "thread.revert",
                  commandId: crypto.randomUUID() as CommandId,
                  threadId: first.threadId,
                  toTurnId: first.turnId,
                  files: false,
                })
                .pipe(Effect.ignore)
            : Effect.void,
        ),
      ),
    );
    const { stderr, code } = await verdandiRun(home, ["--thread", first.threadId, "edit", "a.txt"]);
    expect(stderr).toContain("The verifier exit 1 failed (exit 1)");
    expect(stderr).toContain("the thread was reverted before Verdandi decided whether to escalate it");
    expect(code).toBe(exitCodes.failed);
  },
  spawnTimeout,
);

test(
  "--worktree runs the new thread in a worktree of its own, never in the workspace",
  async () => {
    const { home } = await startServer();
    const repo = makeTempRepo({ "a.txt": "one\n" });
    cleanups.push(async () => removeTempHome(repo));
    const { stdout, code } = await verdandiRun(home, [...pinned, "--json", "--project", repo, "--worktree", "hello"]);
    const result = JSON.parse(stdout) as RunResult;
    expect(code).toBe(exitCodes.completed);
    expect(git(repo, "branch", "--list", `verdandi/${result.threadId}`)).toContain(`verdandi/${result.threadId}`);

    const workspace = await verdandiRun(home, [...pinned, "--workspace", "--worktree", "hello"]);
    expect(workspace.stderr).toContain("never the workspace's");
    expect(workspace.code).toBe(exitCodes.usage);
  },
  spawnTimeout,
);

test("bad flags exit with the usage code, naming the fault", async () => {
  const { stderr, code } = await verdandiRun(folder, ["--mode", "yolo", "hello"]);
  expect(stderr).toContain('--mode takes ask, plan or build; not "yolo"');
  expect(code).toBe(exitCodes.usage);
});

// Windows has no SIGINT to send another process; Ctrl+C there reaches the same handler through the console.
test.skipIf(process.platform === "win32")(
  "Ctrl+C interrupts the turn and exits",
  async () => {
    const { home, runtime } = await startServer();
    const started = Promise.withResolvers<void>();
    await runtime.runPromise(
      Effect.flatMap(Engine, (engine) =>
        engine.react(({ event }) => Effect.sync(() => event.type === "turn.started" && started.resolve())),
      ),
    );
    const { stderr, code } = await verdandiRun(home, [...pinned, "hang"], (proc) => {
      void started.promise.then(() => proc.kill("SIGINT"));
    });
    expect(stderr).toContain("[interrupted on fake low via fake");
    expect(code).toBe(exitCodes.interrupted);
  },
  spawnTimeout,
);
