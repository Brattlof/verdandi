import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandId, ThreadId, TurnId } from "@verdandi/contracts";
import { makeNativeAdapter } from "@verdandi/harness-native";
import {
  type FakeReply,
  gitHeavyTimeout,
  makeFakeAnthropic,
  makeFakeHarness,
  makeTempHome,
  makeTempRepo,
  removeTempHome,
} from "@verdandi/testkit";
import { Effect, ManagedRuntime } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { loadThreadSummaries, loadThreadView } from "../event-store/projector.ts";
import { Reactor } from "../event-store/reactor.ts";
import { loadUsageReport } from "../spend/usage.ts";
import { compressionSummary } from "./compression.ts";

setDefaultTimeout(gitHeavyTimeout);

const dirs: string[] = [];
const runtimes: ManagedRuntime.ManagedRuntime<unknown, unknown>[] = [];
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.dispose();
  for (const d of dirs.splice(0)) removeTempHome(d);
});
let n = 0;
const id = <T>() => `id-${++n}` as T;
const threadId = "thread-1" as ThreadId;

/**
 * A verdandid running the native harness on the fake Anthropic API (`script`), pinned to Haiku's 200K window, and the
 * fake harness, which the project's policy gives compressions to.
 */
const setup = async (script: readonly FakeReply[]) => {
  const home = makeTempHome();
  const projectPath = makeTempRepo({ "a.txt": "one\n" });
  dirs.push(home, projectPath);
  mkdirSync(join(projectPath, ".verdandi"));
  writeFileSync(
    join(projectPath, ".verdandi", "routing.yaml"),
    [
      "targets:",
      "  helper: { harness: fake, provider: fake, model: fake-small }",
      "routes:",
      "  aux.compress: { prefer: [helper], effort: low }",
    ].join("\n"),
  );
  const anthropic = makeFakeAnthropic(script);
  const sessionsDir = join(home, "native-sessions");
  const native = makeNativeAdapter({
    apiKey: "sk-ant-test",
    sessionsDir,
    reach: { home, folders: [], readable: [] },
    terminal: { run: async () => ({ exitCode: 0, output: "", durationMs: 0 }), outputs: join(home, "terminal-output") },
    fetch: anthropic.fetch,
    cacheBreaks: "throw",
  });
  const runtime = ManagedRuntime.make(AppLayer(home, { fake: makeFakeHarness(), native }));
  runtimes.push(runtime as never);
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | Engine | Reactor>) => runtime.runPromise(effect);
  const dispatch = (c: Command) => run(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  await dispatch({
    type: "thread.create",
    commandId: id<CommandId>(),
    threadId,
    projectPath,
    route: { harness: "native", model: "claude-haiku-4-5", effort: "low" },
  });
  return {
    anthropic,
    /** Sends `text` as the thread's next turn and waits until nothing runs: the turn, and any compression it waits on. */
    send: async (text: string) => {
      await dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId: id<TurnId>(), text, mode: "build" });
      await run(Effect.flatMap(Reactor, (r) => r.drain));
    },
    /** Makes the thread's native session long, as many turns of big tool results would, and has the next turn read it from disk. */
    lengthen: async () => {
      const [file] = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
      const lines = Array.from({ length: 50 }, (_, k) => [
        { turnId: `old-${k}`, message: { role: "user", content: [{ type: "text", text: `Fix issue #${400 + k}.` }] } },
        { turnId: `old-${k}`, message: { role: "assistant", content: [{ type: "text", text: "row ".repeat(1_900) }] } },
      ]).flat();
      appendFileSync(join(sessionsDir, file ?? ""), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
      await Effect.runPromise(native.close(threadId));
    },
    view: () => run(loadThreadView(threadId)),
    threads: () => run(loadThreadSummaries()),
    usage: () => run(loadUsageReport({}, new Date())),
  };
};

test("a native session past its trigger is summarized by an aux.compress task, recorded on the turn with its cost", async () => {
  const s = await setup([
    { blocks: [{ type: "text", text: "Hello." }] },
    // The next turn's first request reaches 170K of Haiku's 200K, past its 80% trigger, so the next one compresses.
    { blocks: [{ type: "tool_use", id: "toolu_1", name: "glob", input: { pattern: "*.txt" } }], usage: { input: 170_000 } },
    { blocks: [{ type: "text", text: "Still on it." }] },
  ]);
  await s.send("Balance the ledger.");
  await s.lengthen();
  await s.send("Keep going.");

  const turn = (await s.view())?.turns.at(-1);
  expect(turn?.status).toBe("success");
  const compressed = turn?.items.find((i) => i.kind === "compression");
  expect(compressed).toMatchObject({ kind: "compression", tokensBefore: 170_000, summarized: true, costUsd: 0.01 });
  // The request after it leads with the summary: the aux task's sections, fenced as data, then the user's words.
  const lead = JSON.stringify(((s.anthropic.requests[2]?.body.messages ?? []) as unknown[])[0]);
  expect(lead).toContain("<verdandi-compression>");
  expect(lead).toContain("## Goal\\nBalance the ledger.");
  expect(lead).toContain("## Files touched");
  expect(lead).toContain("> Fix issue #400.");
  // It ran as a hidden task of its own class.
  expect((await s.threads()).map((t) => t.threadId)).toEqual([threadId]);
  expect((await s.usage()).byClass.find((c) => c.taskClass === "aux.compress")).toMatchObject({ tasks: 1 });
});

test("a compression's summary fails closed: a reply missing a section is refused", () => {
  const full = ["Goal", "Constraints", "Progress", "Decisions", "Open issues", "Next steps", "Pending user asks"].map(
    (s) => `## ${s}\nNone.`,
  );
  expect(compressionSummary(full.join("\n"), ["a.txt"])).toEqual({ sections: expect.stringContaining("## Files touched\n- a.txt") });
  expect(compressionSummary(full.slice(0, -1).join("\n"), undefined)).toEqual({ error: "the summary left out Pending user asks" });
});
