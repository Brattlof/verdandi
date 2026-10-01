import { afterEach, expect, test } from "bun:test";
import { makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect } from "effect";
import { runVerifier } from "./verify.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeTempHome(d);
});
/** The folder's path has a space in it (Windows paths with spaces). */
const cwd = () => {
  const d = makeTempHome();
  dirs.push(d);
  return d;
};

test("a command that exits 0 passes, with what it printed", async () => {
  const run = await Effect.runPromise(runVerifier("echo checked", cwd()));
  expect(run).toMatchObject({ command: "echo checked", passed: true, exitCode: 0 });
  expect(run.output.trim()).toBe("checked");
});

test("a command that exits non-zero fails with its exit code", async () => {
  const run = await Effect.runPromise(runVerifier("exit 3", cwd()));
  expect(run).toMatchObject({ passed: false, exitCode: 3 });
});

test("a command over its time limit is stopped and fails", async () => {
  const sleeper = `"${process.execPath}" -e "setTimeout(() => {}, 60000)"`;
  const run = await Effect.runPromise(runVerifier(sleeper, cwd(), 200));
  expect(run).toMatchObject({ passed: false, exitCode: null });
  expect(run.output).toContain("Verdandi stopped it");
  expect(run.durationMs).toBeLessThan(30_000);
});

test.skipIf(process.platform === "win32")("a background process holding the output open doesn't keep the verifier waiting", async () => {
  const run = await Effect.runPromise(runVerifier("sleep 60 & echo done", cwd()));
  expect(run).toMatchObject({ passed: true, exitCode: 0 });
  expect(run.durationMs).toBeLessThan(30_000);
});
