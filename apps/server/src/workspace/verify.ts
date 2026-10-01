import type { VerifierRun } from "@verdandi/contracts";
import { Effect, Option } from "effect";

/** How much of a verifier's output is kept: the end, where test runners print failures and totals. */
const TAIL = 8 * 1024;
// ponytail: one fixed limit for every verifier. Upgrade: a policy key, once a project's suite needs longer.
export const verifierTimeoutMs = 10 * 60 * 1000;

/** The platform shell, as Node's `shell: true` runs it: `cmd /d /s /c "<command>"` strips the outer quotes. */
const shell = (command: string) =>
  process.platform === "win32" ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", `"${command}"`] : ["/bin/sh", "-c", command];

/** Kills the verifier's process tree by the PID captured at spawn, never by name. POSIX: its process group. */
const killTree = (proc: Bun.Subprocess) => {
  if (process.platform === "win32") {
    if (proc.exitCode === null) Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(-proc.pid, "SIGKILL"); // also what it left running in the background
  } catch {
    // The group has already exited.
  }
};

/** Collects the tail of both output streams in arrival order. `read` waits up to `graceMs` for them to close. */
const collect = (streams: readonly ReadableStream<Uint8Array>[]) => {
  let text = "";
  const readers = streams.map((s) => s.getReader());
  const done = Promise.all(
    readers.map(async (reader) => {
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }));
        if (chunk.done) return;
        text += decoder.decode(chunk.value, { stream: true });
        if (text.length > 2 * TAIL) text = text.slice(-TAIL);
      }
    }),
  );
  return async (graceMs: number) => {
    // A background process the command started can hold the pipes open after it exits.
    await Promise.race([done, Bun.sleep(graceMs)]);
    for (const reader of readers) reader.cancel().catch(() => {});
    return text.length > TAIL ? `…${text.slice(-TAIL)}` : text;
  };
};

/**
 * Runs `command` through the platform shell in `cwd`, with no input, and stops it after `timeoutMs`.
 * Interrupting the effect kills it and whatever it started.
 */
export const runVerifier = (command: string, cwd: string, timeoutMs = verifierTimeoutMs): Effect.Effect<VerifierRun> => {
  const started = performance.now();
  const result = (exitCode: number | null, output: string): VerifierRun => ({
    command,
    passed: exitCode === 0,
    exitCode,
    durationMs: Math.round(performance.now() - started),
    output,
  });
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      try {
        return Bun.spawn(shell(command), {
          cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: process.platform !== "win32",
          windowsVerbatimArguments: true,
          windowsHide: true,
        });
      } catch (e) {
        return e instanceof Error ? e : new Error(String(e));
      }
    }),
    (proc) =>
      proc instanceof Error
        ? Effect.succeed(result(null, `Verdandi couldn't start it: ${proc.message}`))
        : Effect.gen(function* () {
            const read = collect([proc.stdout, proc.stderr]);
            const exited = yield* Effect.promise(() => proc.exited).pipe(Effect.timeoutOption(timeoutMs));
            if (Option.isNone(exited)) killTree(proc);
            const output = yield* Effect.promise(() => read(1000));
            return Option.isSome(exited)
              ? result(exited.value, output)
              : result(null, `${output}\n[Verdandi stopped it after ${Math.round(timeoutMs / 1000)} seconds.]`);
          }),
    (proc) => Effect.sync(() => proc instanceof Error || killTree(proc)),
  );
};
