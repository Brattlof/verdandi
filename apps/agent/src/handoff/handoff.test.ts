import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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
import { runShell } from "../verifiers/verify.ts";
import { handoffSummary } from "./handoff.ts";

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
 * A verdandid running the fake harness and the native one on the fake Anthropic API (`script`), and a routed thread
 * in a git project whose policy runs tasks on the fake model and handoffs on `handoffTarget`.
 */
const setup = async (script: readonly FakeReply[], handoffTarget = "{ harness: fake, provider: fake, model: fake-small }") => {
  const home = makeTempHome();
  const projectPath = makeTempRepo({ "a.txt": "one\n" });
  dirs.push(home, projectPath);
  mkdirSync(join(projectPath, ".verdandi"));
  writeFileSync(
    join(projectPath, ".verdandi", "routing.yaml"),
    [
      "minConfidence: 1",
      "targets:",
      `  helper: ${handoffTarget}`,
      "  mid: { harness: fake, provider: fake, model: fake }",
      "routes:",
      "  aux.handoff: { prefer: [helper], effort: low }",
      "fallback: { prefer: [mid], effort: medium }",
    ].join("\n"),
  );
  const fake = makeFakeHarness();
  const anthropic = makeFakeAnthropic(script);
  const native = makeNativeAdapter({
    apiKey: "sk-ant-test",
    sessionsDir: join(home, "native-sessions"),
    reach: { home, folders: [], readable: [join(home, "attachments")] },
    terminal: {
      run: (command, cwd, { timeoutMs, outputFile, signal }) =>
        Effect.runPromise(runShell(command, cwd, { timeoutMs, outputFile }), { signal }),
      outputs: join(home, "terminal-output"),
    },
    fetch: anthropic.fetch,
    cacheBreaks: "throw",
  });
  const runtime = ManagedRuntime.make(AppLayer(home, { fake, native }));
  runtimes.push(runtime as never);
  const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | Engine | Reactor>) => runtime.runPromise(effect);
  const dispatch = (c: Command) => run(Effect.flatMap(Engine, (e) => e.dispatch(c)));
  await dispatch({ type: "thread.create", commandId: id<CommandId>(), threadId, projectPath });
  return {
    projectPath,
    fake,
    anthropic,
    /** Sends `text` as the thread's next turn and waits until nothing runs: the turn, and any handoff it waits on. */
    send: async (text: string) => {
      await dispatch({ type: "turn.send", commandId: id<CommandId>(), threadId, turnId: id<TurnId>(), text, mode: "build" });
      await run(Effect.flatMap(Reactor, (r) => r.drain));
    },
    moveToNative: () =>
      dispatch({
        type: "thread.route.set",
        commandId: id<CommandId>(),
        threadId,
        route: { harness: "native", model: "claude-sonnet-5-5", effort: "medium" },
      }),
    view: () => run(loadThreadView(threadId)),
    threads: () => run(loadThreadSummaries()),
    usage: () => run(loadUsageReport({}, new Date())),
  };
};

/** The text blocks of the first message the native session sent. */
const firstMessage = (requests: ReturnType<typeof makeFakeAnthropic>["requests"]) => {
  const [first] = (requests[0]?.body.messages ?? []) as { content: { type: string; text?: string }[] }[];
  return first?.content.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])) ?? [];
};

test("a thread moving from the fake harness to native starts its new session from a handoff summary, costed as aux.handoff", async () => {
  const s = await setup([{ blocks: [{ type: "text", text: "Picking it up." }] }]);
  await s.send(`edit ${join(s.projectPath, "a.txt")}`);
  // The thread's first session needs no handoff.
  expect(s.fake.calls[0]?.handoff).toBeUndefined();

  await s.moveToNative();
  await s.send("carry on");

  const turn = (await s.view())?.turns.at(-1);
  expect(turn?.status).toBe("success");
  const handoff = turn?.items.find((i) => i.kind === "handoff");
  expect(handoff).toMatchObject({ kind: "handoff", from: "fake", to: "native" });
  const summary = handoff?.kind === "handoff" ? handoff.summary : "";
  // The model writes the sections; the files come from the thread's checkpoints, never the model.
  expect(summary).toContain(`## Goal\nedit ${join(s.projectPath, "a.txt")}`);
  expect(summary).toContain("## Files touched\n- a.txt");
  expect(summary).toContain("## Next steps\n- Carry on.");

  // The new session's first message leads with the summary, fenced as data, before the turn's own text.
  const [lead, ...rest] = firstMessage(s.anthropic.requests);
  expect(lead).toStartWith("<verdandi-handoff>");
  expect(lead).toContain("## Files touched\n- a.txt");
  expect(rest.at(-1)).toContain("carry on");

  // The handoff ran as a hidden task of its own class, on the policy's cheap target.
  expect((await s.threads()).map((t) => t.threadId)).toEqual([threadId]);
  const byClass = (await s.usage()).byClass;
  expect(byClass.find((c) => c.taskClass === "aux.handoff")).toMatchObject({ tasks: 1, cost: { subscriptionUsd: 0.01 } });
});

test("a handoff that fails leaves a notice, and the turn goes on without a summary", async () => {
  const s = await setup(
    [
      // The handoff's own turn, on native's Haiku, is refused; then the thread's turn answers.
      { error: { status: 400, type: "invalid_request_error", message: "nope" } },
      { blocks: [{ type: "text", text: "Starting fresh." }] },
    ],
    "{ harness: native, provider: anthropic, model: claude-haiku-4-5 }",
  );
  await s.send("hello");
  await s.moveToNative();
  await s.send("carry on");

  const turn = (await s.view())?.turns.at(-1);
  expect(turn?.status).toBe("success");
  expect(turn?.items.some((i) => i.kind === "handoff")).toBe(false);
  expect(turn?.items).toContainEqual({ kind: "notice", text: expect.stringContaining("ended without a summary") });
  // The thread's turn is the second request, and starts with the user's own text.
  expect(s.anthropic.requests).toHaveLength(2);
  const sent = s.anthropic.requests[1]?.body.messages as { content: { type: string; text?: string }[] }[];
  expect(JSON.stringify(sent)).not.toContain("verdandi-handoff");
});

test("a summary keeps its fixed sections: the model's sorted into them, Files touched from the checkpoints", () => {
  const reply = ["## Next steps", "- Ship it.", "## Files touched", "- made-up.ts", "## Goal", "Fix the flaky test."].join("\n");
  expect(handoffSummary(reply, ["src/a.ts"])).toBe(
    [
      "## Goal\nFix the flaky test.",
      "## Constraints\nNone.",
      "## Progress\nNone.",
      "## Decisions\nNone.",
      "## Files touched\n- src/a.ts",
      "## Open issues\nNone.",
      "## Next steps\n- Ship it.",
    ].join("\n\n"),
  );
  // A reply without headings is all progress; a folder outside git can't say what was touched.
  expect(handoffSummary("Did the thing.", undefined)).toContain("## Progress\nDid the thing.");
  expect(handoffSummary("Did the thing.", undefined)).toContain("## Files touched\nNot known: the thread's folder has no checkpoints.");
});
