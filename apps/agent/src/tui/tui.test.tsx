import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { CommandId, ThreadId } from "@verdandi/contracts";
import { makeFakeHarness, makeTempHome, removeTempHome } from "@verdandi/testkit";
import { Effect, Layer, ManagedRuntime } from "effect";
import { Client, type Io, openSession } from "../cli/chat-session.ts";
import { connect } from "../rpc/client.ts";
import { ServerInfo, ServerLayer } from "../rpc/server.ts";
import { appendText, Chat, createTranscript } from "./tui.tsx";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

test("text continues the last line until a newline starts the next, CRLF included", () => {
  expect(appendText([""], "echo: ")).toEqual(["echo: "]);
  expect(appendText(["echo: "], "hel")).toEqual(["echo: hel"]);
  expect(appendText(["echo: hel"], "lo\r\n[done]\n")).toEqual(["echo: hello", "[done]", ""]);
});

test("a long transcript keeps its newest lines, numbered from the start, so trimming never renumbers one", () => {
  const transcript = createTranscript();
  for (let i = 0; i < 2500; i++) transcript.write(`line ${i}\n`);
  const { lines, dropped } = transcript.get();
  expect(lines.length).toBeLessThanOrEqual(2000);
  expect(lines.at(-2)).toBe("line 2499");
  // Line n of the whole transcript sits at index n - dropped.
  expect(lines[1000 - dropped + 1000]).toBe("line 2000");
});

/**
 * verdandid on the fake harness, a pinned thread, and the terminal UI's session on it, rendered headless. `seen` waits
 * on the transcript's own change notices, not a timer, until it shows `text`, then renders a frame to check.
 */
const openChat = async () => {
  const home = makeTempHome();
  const server = ManagedRuntime.make(ServerLayer(home, { fake: makeFakeHarness() }));
  cleanups.push(() => removeTempHome(home));
  cleanups.push(() => server.dispose());
  const info = await server.runPromise(
    Effect.gen(function* () {
      return yield* ServerInfo;
    }),
  );
  const runtime = ManagedRuntime.make(Layer.effect(Client)(connect(info)));
  cleanups.push(() => runtime.dispose());
  const client = await runtime.runPromise(
    Effect.gen(function* () {
      return yield* Client;
    }),
  );
  const threadId = crypto.randomUUID() as ThreadId;
  const route = { harness: "fake", model: "fake", effort: "low" } as const;
  await runtime.runPromise(
    client.CommandDispatch({ type: "thread.create", commandId: crypto.randomUUID() as CommandId, threadId, projectPath: home, route }),
  );
  const transcript = createTranscript();
  const io: Io = { write: transcript.write, prompt: transcript.touch, suspend: (run) => run() };
  const session = await openSession(
    { runtime, client, threadId, home, argv: [], picked: undefined, worktree: false, budget: undefined },
    io,
    [],
  );
  cleanups.push(() => session.close());
  const quit = Promise.withResolvers<void>();
  const ui = await testRender(<Chat session={session} transcript={transcript} onQuit={quit.resolve} />, { width: 100, height: 30 });
  cleanups.push(() => ui.renderer.destroy());
  const shows = (...texts: string[]) => {
    const all = transcript.get().lines.join("\n");
    return texts.every((t) => all.includes(t));
  };
  const seen = async (...texts: string[]) => {
    if (!shows(...texts)) {
      const changed = Promise.withResolvers<void>();
      const stop = transcript.subscribe(() => shows(...texts) && changed.resolve());
      await changed.promise.finally(stop);
    }
    await ui.renderOnce();
    return ui.captureCharFrame();
  };
  const send = async (text: string) => {
    await ui.mockInput.typeText(text);
    ui.mockInput.pressEnter();
  };
  return { home, ui, send, seen, quit: quit.promise };
};

test("a message typed in the terminal UI reaches the agent, and its reply streams into the transcript", async () => {
  const { send, seen } = await openChat();
  await send("hello");
  const frame = await seen("echo: hello", "[success");
  expect(frame).toContain("> hello");
  expect(frame).toContain("echo: hello");
  expect(frame).toContain("Enter sends");
});

test("an approval shows what a typed line answers, and y allows it", async () => {
  const { send, seen } = await openChat();
  await send("approve");
  expect(await seen("[approval]")).toContain("Answer the request above: y or n");
  await send("y");
  // The fake harness doesn't stream its reply after a request, so the turn's end line shows the answer went through.
  const frame = await seen("[success");
  expect(frame).toContain("Allow? [y/n] y");
  expect(frame).not.toContain("Answer y or n");
  expect(frame).toContain("Enter sends");
});

test("/exit quits", async () => {
  const { send, quit } = await openChat();
  await send("/exit");
  await quit;
});

test("/skills pins a skill through verdandid, lists it pinned, and shows its history", async () => {
  const { home, send, seen } = await openChat();
  mkdirSync(join(home, "skills", "mine"), { recursive: true });
  writeFileSync(join(home, "skills", "mine", "SKILL.md"), "---\nname: mine\ndescription: My own steps.\n---\nSteps.\n");
  await send("/skills pin mine");
  await seen("Pinned mine: agents can't change it");
  await send("/skills");
  expect(await seen("(pinned)")).toContain("My own steps. (pinned)");
  await send("/skills history mine");
  await seen("No change to mine was written by Verdandi yet.");
});
