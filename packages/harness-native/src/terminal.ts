import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Runs one shell command for the terminal tool: verdandid's runner (`runShell`, shared with verifiers), which passes
 * the environment without secrets, keeps the output's tail, writes all of it to `outputFile`, and kills the command's
 * process tree when `signal` aborts or `timeoutMs` passes.
 */
export type RunCommand = (
  command: string,
  cwd: string,
  options: { readonly timeoutMs: number; readonly outputFile: string; readonly signal: AbortSignal },
) => Promise<{ readonly exitCode: number | null; readonly output: string; readonly durationMs: number }>;

/** The terminal tool's runner and the profile's folder for whole outputs, which `read_file` may read. */
export type Terminal = { readonly run: RunCommand; readonly outputs: string };

export const terminalTool = "terminal";
const defaultSeconds = 120;
const maxSeconds = 600;
/** How many whole outputs the folder keeps; older ones go as new ones come. */
const keptOutputs = 200;

const shellName = process.platform === "win32" ? "cmd.exe" : "/bin/sh";

export const terminalDefinition: Anthropic.Tool = {
  name: terminalTool,
  description: `Runs one shell command (${shellName}) in the thread's folder, with no input, after the user approves it. Returns the exit code and the end of the output, and where the whole output is for read_file. Stops it after \`timeout_seconds\` (default ${defaultSeconds}, at most ${maxSeconds}).`,
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line, as the shell takes it." },
      timeout_seconds: {
        type: "integer",
        description: `How long it may run, in seconds; default ${defaultSeconds}, at most ${maxSeconds}.`,
      },
    },
    required: ["command"],
  },
};

/**
 * Drops the oldest whole outputs past `keptOutputs`; names start with the time, so they sort oldest first.
 * ponytail: a count, not an age; upgrade to the cleanup sweep's `keepDays` (ADR 0021) once its report lists outputs.
 */
const prune = (dir: string) => {
  try {
    const names = readdirSync(dir).sort();
    for (const name of names.slice(0, Math.max(0, names.length - keptOutputs))) rmSync(join(dir, name), { force: true });
  } catch {
    // The folder isn't there yet, or a file is in use: the next run tries again.
  }
};

/** Runs an approved command and describes what it did for the agent. Never throws: a failure is a result with `isError`. */
export const runTerminal = async (
  args: Readonly<Record<string, unknown>>,
  cwd: string,
  terminal: Terminal,
  toolUseId: string,
  signal: AbortSignal,
): Promise<{ readonly text: string; readonly isError?: boolean }> => {
  const command = typeof args.command === "string" ? args.command : "";
  const asked = typeof args.timeout_seconds === "number" && args.timeout_seconds > 0 ? args.timeout_seconds : defaultSeconds;
  const outputFile = join(terminal.outputs, `${Date.now()}-${toolUseId}.log`);
  try {
    const run = await terminal.run(command, cwd, { timeoutMs: Math.min(asked, maxSeconds) * 1000, outputFile, signal });
    prune(terminal.outputs);
    const status = run.exitCode === null ? "It didn't finish" : `Exit code ${run.exitCode}`;
    return {
      text: `${status} (${(run.durationMs / 1000).toFixed(1)} s).\n${run.output.trim() === "" ? "(no output)" : run.output}\n[The whole output is at ${outputFile}; read it with read_file.]`,
      isError: run.exitCode !== 0,
    };
  } catch (e) {
    return { text: `The command couldn't run: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
};
