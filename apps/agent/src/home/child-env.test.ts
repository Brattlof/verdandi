import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { keyVariable } from "@verdandi/harness-native";
import { makeTempHome, removeTempHome } from "@verdandi/testkit";

const fakeKey = "sk-ant-test-not-a-real-key";

test("a key verdandid loads from .env reaches the native harness and no process it starts", async () => {
  const folder = makeTempHome();
  try {
    // Bun loads the .env of the folder a process starts in into the environment its children inherit.
    writeFileSync(join(folder, ".env"), `${keyVariable}=${fakeKey}\n`);
    const echo = process.platform === "win32" ? `echo [%${keyVariable}%]` : `echo "[$${keyVariable}]"`;
    const script = `
      const { Effect } = await import(${JSON.stringify(import.meta.resolve("effect"))});
      const { nativeHarness } = await import(${JSON.stringify(join(import.meta.dir, "..", "native", "native-harness.ts"))});
      const { runVerifier } = await import(${JSON.stringify(join(import.meta.dir, "..", "verifiers", "verify.ts"))});
      const { childEnv } = await import(${JSON.stringify(join(import.meta.dir, "child-env.ts"))});
      const none = { get: async () => null, set: async () => {}, delete: async () => false };
      const native = await nativeHarness(process.cwd(), process.env, none);
      const verifier = await Effect.runPromise(runVerifier(${JSON.stringify(echo)}, process.cwd()));
      console.log(JSON.stringify({
        native: native.adapter !== undefined, status: native.status, verifier: verifier.output,
        processEnv: process.env.${keyVariable} ?? null, childEnv: childEnv().${keyVariable} ?? null,
      }));`;
    const proc = Bun.spawn([process.execPath, "-e", script], { cwd: folder, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect(stderr).toBe("");
    const seen = JSON.parse(stdout);
    expect(seen.native).toBe(true);
    expect(seen.status).toContain(`with the key from ${keyVariable}`);
    expect(seen.processEnv).toBeNull();
    expect(seen.childEnv).toBeNull();
    expect(seen.verifier).not.toContain(fakeKey);
    expect(stdout).not.toContain(fakeKey);
  } finally {
    removeTempHome(folder);
  }
});
