import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { type HarnessAdapter, HarnessError, type HarnessId } from "@verdandi/contracts";
import { findClaude, makeClaudeCodeAdapter } from "@verdandi/harness-claude-code";
import { makeFakeHarness } from "@verdandi/testkit";
import { Effect, Layer, Logger, ManagedRuntime, References, Stream } from "effect";
import { attachmentsDir } from "./attachments/attachments.ts";
import { loadGatewayConfig } from "./gateway/gateway-config.ts";
import { findTelegramToken, makeTelegramAdapter } from "./gateway/telegram.ts";
import { childEnv } from "./home/child-env.ts";
import { flag, resolveHome, runningServer, type ServerFile, serverFile } from "./home/home.ts";
import { ensureWorkspace, loadTrustedFolders } from "./home/workspace.ts";
import { nativeHarness } from "./native/native-harness.ts";
import { ServerInfo, ServerLayer } from "./rpc/server.ts";
import { skillsPlugin } from "./skills/skills-config.ts";

const claudeMissing: HarnessAdapter = {
  id: "claude-code",
  run: () => Stream.fail(new HarnessError({ message: "Claude Code CLI not found on PATH. Install it and run `claude` once to log in." })),
  respond: () => Effect.void,
  reroute: () => Effect.void,
  close: () => Effect.void,
};

/**
 * Starts verdandid in this process, listening on 127.0.0.1 (`port`, or any free one), and writes `server.json` so clients
 * find it. Returns it with lines saying what runs, and `stop`, which shuts it down. Its logs go to stderr, so a chat or
 * `verdandi run --json` sharing the process keeps stdout; `quiet`, for those, keeps only warnings and leaves out the
 * lines about what runs as usual. Only an `alwaysOn` one (`verdandi start`) reads `gateway.yaml` and connects chat apps, so a
 * bot never goes offline when a terminal closes (DESIGN §11).
 */
export const serve = async (
  home: string,
  argv: readonly string[],
  options: { readonly port?: number; readonly quiet?: boolean; readonly alwaysOn?: boolean } = {},
) => {
  mkdirSync(attachmentsDir(home), { recursive: true });
  const file = serverFile(home);
  const running = runningServer(home);
  if (running) throw new Error(`verdandid is already running for ${home} (pid ${running.pid}). Stop it before starting another.`);
  ensureWorkspace(home);
  // A broken workspace.yaml stops here, naming the file and key.
  const folders = loadTrustedFolders(home);
  // A broken gateway.yaml or a malformed bot token stops an always-on verdandid here, naming the fix; one a chat runs never
  // reads them. The token is read before the native harness takes Verdandi's secrets out of the environment.
  const telegram = options.alwaysOn ? await findTelegramToken(process.env, Bun.secrets) : undefined;
  const gateway = options.alwaysOn
    ? { config: loadGatewayConfig(home), adapters: telegram?.token ? [makeTelegramAdapter({ token: telegram.token })] : [] }
    : undefined;
  const claudePath = findClaude();
  // Only with an Anthropic API key configured; a malformed one stops here, naming the fix.
  const native = await nativeHarness(home, folders);
  const harnesses: Partial<Record<HarnessId, HarnessAdapter>> = {
    "claude-code": claudePath
      ? makeClaudeCodeAdapter({
          claudePath,
          additionalDirectories: [attachmentsDir(home)],
          folders,
          plugins: [skillsPlugin(home)],
          env: childEnv(),
        })
      : claudeMissing,
    ...(native.adapter && { native: native.adapter }),
    // The fake harness answers without any model call: for trying the loop end to end.
    ...(argv.includes("--dev-fake-harness") ? { fake: makeFakeHarness() } : {}),
  };
  const logs = Layer.mergeAll(
    Logger.layer([Logger.withConsoleError(Logger.formatSimple)]),
    Layer.succeed(References.MinimumLogLevel, options.quiet ? "Warn" : "Info"),
  );
  const { port } = options;
  const runtime = ManagedRuntime.make(
    ServerLayer(home, harnesses, { ...(port !== undefined && { port }), ...(gateway && { gateway }) }).pipe(Layer.provide(logs)),
  );
  const info = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ServerInfo;
    }),
  );
  const server = { port: info.port, token: info.token, pid: process.pid } satisfies ServerFile;
  writeFileSync(file, JSON.stringify(server), { mode: 0o600 });
  // A process that exits without `stop` (a second Ctrl+C) leaves no server.json behind for clients to try.
  const forget = () => rmSync(file, { force: true });
  process.once("exit", forget);
  const status = [
    ...(claudePath ? [] : ["Claude Code CLI not found on PATH; claude-code turns will fail until it is installed."]),
    ...(options.quiet ? [] : [native.status]),
    ...(telegram
      ? [
          telegram.token !== undefined
            ? `Telegram gateway on (bot token from ${telegram.source}).`
            : `Telegram gateway off: ${telegram.reason}.`,
        ]
      : []),
    ...(folders.length ? [`The agent also works in ${folders.join(", ")} as in a thread's own folder (workspace.yaml).`] : []),
  ];
  const stop = async () => {
    forget();
    process.off("exit", forget);
    await runtime.dispose();
  };
  return { server, status, stop };
};

/**
 * The verdandid running for `home`, or one started in this process when none is (`serve`), with `stop` to shut that
 * one down when the command ends. Bare `verdandi` and `verdandi run` use this, so neither needs `verdandi start` first.
 */
export const serverFor = async (home: string, argv: readonly string[]) => {
  const running = runningServer(home);
  return running ? { server: running, status: [], stop: undefined } : await serve(home, argv, { quiet: true });
};

/**
 * `verdandi start`: runs verdandid in the foreground until Ctrl+C, for the clients that need it to outlive a chat (the
 * web UI, the messaging gateway, which only it runs, and later the scheduler and desktop app). It listens only on 127.0.0.1 and serves no web page
 * (ADR 0026): `verdandi web` serves the UI, and its `--host` opens that to other devices.
 */
export const start = async (argv: readonly string[]) => {
  const home = resolveHome(argv);
  if (argv.some((a) => a === "--host" || a.startsWith("--host=")))
    throw new Error("verdandid listens only on 127.0.0.1. To use the web UI from another device, run: verdandi web --host <address>");
  const port = flag(argv, "--port");
  const { server, status, stop: shutdown } = await serve(home, argv, { ...(port !== undefined && { port: Number(port) }), alwaysOn: true });
  console.log(`verdandid listening on 127.0.0.1:${server.port} (home: ${home}). Chat with: verdandi; open the web UI with: verdandi web`);
  for (const line of status) console.log(line);

  const stop = async () => {
    await shutdown();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
};
