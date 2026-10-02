import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { type HarnessAdapter, HarnessError, type HarnessId } from "@verdandi/contracts";
import { findClaude, makeClaudeCodeAdapter } from "@verdandi/harness-claude-code";
import { makeFakeHarness } from "@verdandi/testkit";
import { Effect, ManagedRuntime, Stream } from "effect";
import { attachmentsDir } from "./attachments/attachments.ts";
import { alive, flag, resolveHome, type ServerFile, serverFile } from "./home/home.ts";
import { hostProblem, isLocalAddress, startLanGate } from "./rpc/lan-gate.ts";
import { ServerInfo, ServerLayer } from "./rpc/server.ts";

const claudeMissing: HarnessAdapter = {
  id: "claude-code",
  run: () => Stream.fail(new HarnessError({ message: "Claude Code CLI not found on PATH. Install it and run `claude` once to log in." })),
  respond: () => Effect.void,
  reroute: () => Effect.void,
  close: () => Effect.void,
};

/** This machine's addresses on its local network, for the URLs to open from other devices. */
const lanAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .flatMap((a) => (a && a.family === "IPv4" && !a.internal && isLocalAddress(a.address) ? [a.address] : []));

/**
 * `verdandi start`: runs verdandid in the foreground until Ctrl+C. verdandid itself only listens on
 * 127.0.0.1; `--host` also opens it to the local network through a gate that refuses anything else.
 */
export const start = async (argv: readonly string[]) => {
  const home = resolveHome(argv);
  const host = flag(argv, "--host");
  const problem = host === undefined ? undefined : hostProblem(host);
  if (problem) throw new Error(problem);
  const lan = host !== undefined && host !== "127.0.0.1" && host !== "::1";
  mkdirSync(attachmentsDir(home), { recursive: true });
  const file = serverFile(home);
  if (existsSync(file)) {
    const running = JSON.parse(readFileSync(file, "utf8")) as ServerFile;
    if (alive(running.pid))
      throw new Error(`verdandid is already running for ${home} (pid ${running.pid}). Stop it before starting another.`);
  }
  const claudePath = findClaude();
  const harnesses: Partial<Record<HarnessId, HarnessAdapter>> = {
    "claude-code": claudePath ? makeClaudeCodeAdapter({ claudePath, additionalDirectories: [attachmentsDir(home)] }) : claudeMissing,
    // The fake harness answers without any model call: for trying the loop end to end.
    ...(argv.includes("--dev-fake-harness") ? { fake: makeFakeHarness() } : {}),
  };
  const port = flag(argv, "--port");
  // With a LAN gate, --port is the gate's, the one other devices use, and verdandid takes any free loopback port.
  const runtime = ManagedRuntime.make(ServerLayer(home, harnesses, port === undefined || lan ? {} : { port: Number(port) }));
  const info = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* ServerInfo;
    }),
  );
  writeFileSync(file, JSON.stringify({ port: info.port, token: info.token, pid: process.pid } satisfies ServerFile), { mode: 0o600 });
  console.log(`verdandid listening on 127.0.0.1:${info.port} (home: ${home}). Open the web UI with: verdandi open`);
  if (!claudePath) console.log("Claude Code CLI not found on PATH; claude-code turns will fail until it is installed.");
  const gate = lan && host ? startLanGate(host, port === undefined ? 0 : Number(port), info.port) : undefined;
  if (gate) {
    const addresses = host === "0.0.0.0" || host === "::" ? lanAddresses() : [host ?? ""];
    console.log(
      `Also open on your local network at ${addresses.map((a) => `http://${a}:${gate.port}/`).join(", ") || `port ${gate.port}`}; requests from outside it are refused.`,
    );
    console.log(`From another device, open this URL. It holds your access token, so don't share it:`);
    for (const a of addresses) console.log(`  http://${a}:${gate.port}/#token=${info.token}`);
  }

  const stop = async () => {
    gate?.stop(true);
    rmSync(file, { force: true });
    await runtime.dispose();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
};
