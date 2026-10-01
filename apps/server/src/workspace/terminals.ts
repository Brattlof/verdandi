import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { type TerminalFeed, type TerminalId, TerminalUnavailable, type TerminalView, type ThreadId } from "@verdandi/contracts";
import { Context, Effect, Layer, Queue, Stream } from "effect";
import { type HostReport, type HostRequest, killTree } from "./pty-host.ts";

/** Output kept per terminal for a client that reattaches: the last 256 KiB or so. */
export const keptOutput = 256 * 1024;

type Terminal = {
  view: TerminalView;
  output: string;
  readonly listeners: Set<(message: TerminalFeed | undefined) => void>;
};

/**
 * verdandid's terminals and the PTY host that runs their shells (DESIGN §13, ADR 0007). The host starts with the
 * first terminal; if it dies, its terminals end as `lost` and the next terminal starts a new one. Closing
 * verdandid closes every shell.
 */
export class Terminals extends Context.Service<
  Terminals,
  {
    readonly open: (threadId: ThreadId, cwd: string, cols: number, rows: number) => Effect.Effect<TerminalView, TerminalUnavailable>;
    readonly list: (threadId: ThreadId) => readonly TerminalView[];
    readonly write: (terminalId: TerminalId, data: string) => Effect.Effect<void, TerminalUnavailable>;
    readonly resize: (terminalId: TerminalId, cols: number, rows: number) => Effect.Effect<void, TerminalUnavailable>;
    readonly close: (terminalId: TerminalId) => Effect.Effect<void, TerminalUnavailable>;
    /** The kept output, then live output, until the terminal is closed. */
    readonly feed: (terminalId: TerminalId) => Stream.Stream<TerminalFeed, TerminalUnavailable>;
    /** The running host's PID, for tests that crash it. */
    readonly hostPid: () => number | undefined;
  }
>()("verdandi/Terminals") {}

const hostEntry = fileURLToPath(new URL("./pty-host.ts", import.meta.url));

const notFound = (terminalId: TerminalId) =>
  new TerminalUnavailable({ reason: "TerminalNotFound", message: `Terminal ${terminalId} is closed or never existed. Open a new one.` });

export const TerminalsLive = Layer.effect(
  Terminals,
  Effect.gen(function* () {
    const terminals = new Map<TerminalId, Terminal>();
    /** Replies the host owes: `opened`/`failed` for an open, `closed` for a close. Settled with undefined if the host dies. */
    const waiting = new Map<string, (report: HostReport | undefined) => void>();
    let host: Bun.Subprocess | undefined;

    const publish = (terminal: Terminal, message: TerminalFeed | undefined) => {
      for (const listener of terminal.listeners) listener(message);
    };
    const end = (terminal: Terminal, status: "exited" | "lost", exitCode: number | null) => {
      if (terminal.view.status !== "running") return;
      terminal.view = { ...terminal.view, status, exitCode };
      publish(terminal, { kind: "ended", terminal: terminal.view });
    };

    const onReport = (report: HostReport) => {
      const terminal = terminals.get(report.id as TerminalId);
      if (report.type === "output" && terminal) {
        const output = terminal.output + report.data;
        // Cut at a line break where there is one, so the kept output rarely starts inside an escape sequence.
        const cut = output.length > keptOutput ? output.indexOf("\n", output.length - keptOutput) + 1 || output.length - keptOutput : 0;
        terminal.output = output.slice(cut);
        publish(terminal, { kind: "output", data: report.data });
      } else if (report.type === "exit" && terminal) end(terminal, "exited", report.exitCode);
      else {
        waiting.get(report.id)?.(report);
        waiting.delete(report.id);
      }
    };

    const startHost = () => {
      const proc = Bun.spawn([process.execPath, hostEntry], {
        stdio: ["ignore", "inherit", "inherit"],
        serialization: "json",
        ipc: (report: HostReport) => onReport(report),
      });
      void proc.exited.then(() => {
        if (host !== proc) return;
        host = undefined;
        for (const settle of waiting.values()) settle(undefined);
        waiting.clear();
        for (const terminal of terminals.values()) {
          if (terminal.view.status !== "running") continue;
          killTree(terminal.view.pid); // the host can't any more
          end(terminal, "lost", null);
        }
      });
      return proc;
    };

    const request = (message: HostRequest) => {
      host ??= startHost();
      host.send(message);
    };
    /** Sends `message` and answers with `reply` to the host's reply, called as it arrives, before any later report. */
    const ask = <A, E>(message: HostRequest, reply: (report: HostReport | undefined) => Effect.Effect<A, E>) =>
      Effect.callback<A, E>((resume) => {
        waiting.set(message.id, (report) => resume(reply(report)));
        request(message);
        return Effect.sync(() => waiting.delete(message.id));
      });

    const running = (terminalId: TerminalId) => {
      const terminal = terminals.get(terminalId);
      if (!terminal) return Effect.fail(notFound(terminalId));
      return Effect.succeed(terminal.view.status === "running" ? terminal : undefined);
    };

    const close = (terminalId: TerminalId) =>
      Effect.gen(function* () {
        const terminal = terminals.get(terminalId);
        if (!terminal) return yield* notFound(terminalId);
        // Forgotten first, so a second close finds nothing to close.
        terminals.delete(terminalId);
        publish(terminal, undefined);
        if (terminal.view.status !== "running") return;
        // A host that dies first can't close it, so it's killed here.
        yield* ask({ type: "close", id: terminalId }, (report) => Effect.sync(() => report ?? killTree(terminal.view.pid)));
      });

    // verdandid is stopping: the host closes every shell when its IPC channel closes, then exits.
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        const proc = host;
        if (!proc) return;
        host = undefined; // its exit is expected now, not a crash
        proc.disconnect();
        const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
        if (exited) return;
        for (const terminal of terminals.values()) if (terminal.view.status === "running") killTree(terminal.view.pid);
        proc.kill("SIGKILL");
      }),
    );

    return {
      open: (threadId, cwd, cols, rows) =>
        Effect.suspend(() => {
          const id = randomUUID() as TerminalId;
          return ask({ type: "open", id, cwd, cols, rows }, (report) => {
            if (report?.type !== "opened")
              return Effect.fail(
                new TerminalUnavailable({
                  reason: "SpawnFailed",
                  message: report?.type === "failed" ? report.message : "The PTY host stopped while starting the shell. Try again.",
                }),
              );
            // Registered as the reply arrives, so the shell's first output finds it.
            const view: TerminalView = { terminalId: id, threadId, cwd, pid: report.pid, status: "running", exitCode: null };
            terminals.set(id, { view, output: "", listeners: new Set() });
            return Effect.succeed(view);
          });
        }),
      list: (threadId) => [...terminals.values()].flatMap((t) => (t.view.threadId === threadId ? [t.view] : [])),
      write: (terminalId, data) => Effect.map(running(terminalId), (t) => t && request({ type: "write", id: terminalId, data })),
      resize: (terminalId, cols, rows) =>
        Effect.map(running(terminalId), (t) => t && request({ type: "resize", id: terminalId, cols, rows })),
      close,
      feed: (terminalId) =>
        Stream.callback<TerminalFeed, TerminalUnavailable>((queue) =>
          Effect.acquireRelease(
            Effect.suspend(() => {
              const terminal = terminals.get(terminalId);
              if (!terminal) return Effect.fail(notFound(terminalId));
              // One synchronous step: nothing can arrive between the snapshot and the listener.
              Queue.offerUnsafe(queue, { kind: "snapshot", terminal: terminal.view, output: terminal.output });
              // ponytail: no flow control, so a client that reads slower than a flooding command (`yes`) queues
              // without bound. Upgrade: VS Code's ack-based pause of the PTY, once a real workload hits it.
              const listener = (message: TerminalFeed | undefined) =>
                message ? Queue.offerUnsafe(queue, message) : Queue.endUnsafe(queue);
              terminal.listeners.add(listener);
              return Effect.succeed(() => terminal.listeners.delete(listener));
            }),
            (unlisten) => Effect.sync(unlisten),
          ),
        ),
      hostPid: () => host?.pid,
    };
  }),
);
