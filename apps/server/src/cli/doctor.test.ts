import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { CommandId, ThreadId, TurnId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import { type ServerFile, serverFile } from "../config/home.ts";
import { Engine } from "../orchestration/engine.ts";
import { ServerInfo, ServerLayer } from "../rpc/server.ts";
import { attachmentsDir, storeAttachments } from "../workspace/attachments.ts";
import { type Check, diagnose } from "./doctor.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** A temp home with verdandid running and its server.json written, like `verdandi start`. */
const healthyHome = async () => {
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

// Bun stands in for `claude`: any binary that answers `--version` will do, on every OS.
const tools = { claude: process.execPath, git: Bun.which("git") ?? undefined };
const check = (checks: readonly Check[], name: string) => checks.find((c) => c.name === name);

test("passes on a healthy home, without printing the token", async () => {
  const { home } = await healthyHome();
  const checks = await diagnose(home, tools);
  expect(checks.filter((c) => c.status !== "ok")).toEqual([]);
  const { token } = JSON.parse(await Bun.file(serverFile(home)).text()) as ServerFile;
  expect(checks.some((c) => c.detail.includes(token))).toBe(false);
});

test("fails with the fix when Claude Code isn't on PATH", async () => {
  const { home } = await healthyHome();
  const claude = check(await diagnose(home, { ...tools, claude: undefined }), "Claude Code");
  expect(claude?.status).toBe("fail");
  expect(claude?.detail).toContain("Install it");
});

test("fails with the fix when verdandid has stopped but left its server.json", async () => {
  const { home, runtime } = await healthyHome();
  await runtime.dispose();
  const server = check(await diagnose(home, tools), "verdandid");
  expect(server?.status).toBe("fail");
  expect(server?.detail).toContain("verdandi start");
});

test("counts the stored attachments no turn references", async () => {
  const { home, runtime } = await healthyHome();
  const upload = (text: string) => ({ name: `${text}.log`, mediaType: "text/plain", data: Buffer.from(text).toString("base64") });
  const [sent] = await Effect.runPromise(storeAttachments(attachmentsDir(home), [upload("sent"), upload("never sent")]));
  const threadId = crypto.randomUUID() as ThreadId;
  await runtime.runPromise(
    Effect.gen(function* () {
      const engine = yield* Engine;
      const route = { harness: "fake", model: "fake", effort: "low" } as const;
      yield* engine.dispatch({ type: "thread.create", commandId: crypto.randomUUID() as CommandId, threadId, projectPath: home, route });
      const turnId = crypto.randomUUID() as TurnId;
      const attachments = sent ? [sent] : [];
      yield* engine.dispatch({
        type: "turn.send",
        commandId: crypto.randomUUID() as CommandId,
        threadId,
        turnId,
        text: "look",
        mode: "build",
        attachments,
      });
    }),
  );
  const attachments = check(await diagnose(home, tools), "Attachments");
  expect(attachments?.status).toBe("ok");
  expect(attachments?.detail).toStartWith("2 files");
  expect(attachments?.detail).toContain("1 no turn references");
});
