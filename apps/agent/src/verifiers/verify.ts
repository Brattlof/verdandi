import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { codePointStart, type VerifierRun } from "@verdandi/contracts";
import { Effect, Option } from "effect";
import { childEnv } from "../home/child-env.ts";

/** How much of a command's output is kept: the end, where test runners print failures and totals. */
const TAIL = 8 * 1024;
// ponytail: one fixed limit for every verifier. Upgrade: a policy key, once a project's suite needs longer.
export const verifierTimeoutMs = 10 * 60 * 1000;

/**
 * `Bun.spawn` options that run `command` in the platform shell, as Node's `shell: true` does: `cmd /d /s /c "<command>"`
 * strips the outer quotes. The arguments go to cmd.exe verbatim, since it doesn't read the `\"` that quoting them would add.
 */
export const shell = (command: string) =>
  process.platform === "win32"
    ? { cmd: [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", `"${command}"`], windowsVerbatimArguments: true }
    : { cmd: ["/bin/sh", "-c", command] };

/** Kills the command's process tree by the PID captured at spawn, never by name. POSIX: its process group. */
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

/** Waits for `promise`, or `ms` at most; the timer is cleared either way, so it never keeps the process alive. */
const within = (promise: Promise<unknown>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]).finally(() => clearTimeout(timer));
};

/**
 * Collects the tail of both output streams in arrival order, and all of it into `file` when given. `read` waits up to
 * `graceMs` for them to close.
 */
const collect = (streams: readonly ReadableStream<Uint8Array>[], file: string | undefined) => {
  let text = "";
  const readers = streams.map((s) => s.getReader());
  const sink = file === undefined ? undefined : Bun.file(file).writer();
  const done = Promise.all(
    readers.map(async (reader) => {
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }));
        if (chunk.done) return;
        sink?.write(chunk.value);
        text += decoder.decode(chunk.value, { stream: true });
        if (text.length > 2 * TAIL) text = text.slice(codePointStart(text, text.length - TAIL));
      }
    }),
  );
  return async (graceMs: number) => {
    // A background process the command started can hold the pipes open after it exits.
    await within(done, graceMs);
    for (const reader of readers) reader.cancel().catch(() => {});
    await sink?.end();
    return text.length > TAIL ? `…${text.slice(codePointStart(text, text.length - TAIL))}` : text;
  };
};

/** What a shell command did: its exit code (null when it was stopped or never started), its output's tail, and how long it took. */
export type ShellRun = { readonly exitCode: number | null; readonly output: string; readonly durationMs: number };

/**
 * Runs `command` through the platform shell in `cwd`, with no input and the environment without secrets (`childEnv`),
 * and stops it after `timeoutMs`; all its output also goes to `outputFile` when given. Interrupting the effect kills
 * it and whatever it started. Verifiers, setup commands and the native harness's terminal tool all run through it.
 */
export const runShell = (
  command: string,
  cwd: string,
  options: { readonly timeoutMs: number; readonly outputFile?: string },
): Effect.Effect<ShellRun> => {
  const started = performance.now();
  const result = (exitCode: number | null, output: string): ShellRun => ({
    exitCode,
    output,
    durationMs: Math.round(performance.now() - started),
  });
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      try {
        if (options.outputFile !== undefined) mkdirSync(dirname(options.outputFile), { recursive: true });
        return Bun.spawn({
          ...shell(command),
          cwd,
          env: childEnv(),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: process.platform !== "win32",
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
            const read = collect([proc.stdout, proc.stderr], options.outputFile);
            const exited = yield* Effect.promise(() => proc.exited).pipe(Effect.timeoutOption(options.timeoutMs));
            if (Option.isNone(exited)) killTree(proc);
            const output = yield* Effect.promise(() => read(1000));
            return Option.isSome(exited)
              ? result(exited.value, output)
              : result(null, `${output}\n[Verdandi stopped it after ${Math.round(options.timeoutMs / 1000)} seconds.]`);
          }),
    // Answers once the shell is gone, so an interrupt that returns has left nothing running; bounded, in case it hangs.
    (proc) =>
      proc instanceof Error
        ? Effect.void
        : Effect.promise(() => {
            killTree(proc);
            return within(proc.exited, 5000);
          }),
  );
};

/** Runs a verifier (or a setup command) through `runShell`: it passes when it exits 0. */
export const runVerifier = (command: string, cwd: string, timeoutMs = verifierTimeoutMs): Effect.Effect<VerifierRun> =>
  Effect.map(runShell(command, cwd, { timeoutMs }), (run) => ({ command, passed: run.exitCode === 0, ...run }));
