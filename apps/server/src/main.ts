import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type HarnessAdapter, HarnessError, type HarnessId } from "@verdandi/contracts";
import { findClaude, makeClaudeCodeAdapter } from "@verdandi/harness-claude-code";
import { makeFakeHarness } from "@verdandi/testkit";
import { Effect, ManagedRuntime, Stream } from "effect";
import { alive, flag, resolveHome, type ServerFile, serverFile } from "./config/home.ts";
import { ServerInfo, ServerLayer } from "./rpc/server.ts";

const claudeMissing: HarnessAdapter = {
  id: "claude-code",
  run: () => Stream.fail(new HarnessError({ message: "Claude Code CLI not found on PATH. Install it and run `claude` once to log in." })),
  respond: () => Effect.void,
  reroute: () => Effect.void,
};

/** `verdandi start`: runs verdandid in the foreground until Ctrl+C. */
export const start = async (argv: readonly string[]) => {
  const home = resolveHome(argv);
  mkdirSync(home, { recursive: true });
  const file = serverFile(home);
  if (existsSync(file)) {
    const running = JSON.parse(readFileSync(file, "utf8")) as ServerFile;
    if (alive(running.pid))
      throw new Error(`verdandid is already running for ${home} (pid ${running.pid}). Stop it before starting another.`);
  }
  const claudePath = findClaude();
  const harnesses: Partial<Record<HarnessId, HarnessAdapter>> = {
    "claude-code": claudePath ? makeClaudeCodeAdapter({ claudePath }) : claudeMissing,
    // The fake harness answers without any model call: for trying the loop end to end.
    ...(argv.includes("--dev-fake-harness") ? { fake: makeFakeHarness() } : {}),
  };
  const port = flag(argv, "--port");
  const runtime = ManagedRuntime.make(ServerLayer(home, harnesses, port === undefined ? {} : { port: Number(port) }));
  const info = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ServerInfo;
    }),
  );
  writeFileSync(file, JSON.stringify({ port: info.port, token: info.token, pid: process.pid } satisfies ServerFile), { mode: 0o600 });
  console.log(`verdandid listening on 127.0.0.1:${info.port} (home: ${home}). Open the web UI with: verdandi open`);
  if (!claudePath) console.log("Claude Code CLI not found on PATH; claude-code turns will fail until it is installed.");

  const stop = async () => {
    rmSync(file, { force: true });
    await runtime.dispose();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
};
