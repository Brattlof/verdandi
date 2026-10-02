import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { Engine } from "../event-store/engine.ts";
import { type ServerFile, serverFile } from "../home/home.ts";
import { ServerInfo, ServerLayer } from "../rpc/server.ts";
import { exitCodes, type RunResult } from "./run.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
/** The project folder each run starts in. */
const folder = makeTempHome();
afterAll(() => removeTempHome(folder));

/** Each test spawns the CLI, which takes a second or more on a cold Windows runner: a hang guard, not a wait. */
const spawnTimeout = 30_000;

/** A temp home with verdandid running on the fake harness and its server.json written, like `verdandi start`. */
const startServer = async () => {
  const home = makeTempHome();
  cleanups.push(async () => removeTempHome(home));
  const runtime = ManagedRuntime.make(ServerLayer(home, { fake: makeFakeHarness() }));
  cleanups.push(() => runtime.dispose());
  const info = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ServerInfo;
    }),
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
    const { home } = await startServer();
    mkdirSync(join(project, ".verdandi"));
    writeFileSync(join(project, ".verdandi", "routing.yaml"), 'escalation: { verifiers: ["echo broken && exit 1"] }');
    const { stderr, code } = await verdandiRun(home, [...pinned, "--project", project, "edit", "a.txt"]);
    expect(stderr).toContain("The verifier echo broken && exit 1 failed (exit 1):\nbroken");
    expect(code).toBe(exitCodes.failed);
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
