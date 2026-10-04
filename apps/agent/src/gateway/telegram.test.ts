import { expect, test } from "bun:test";
import { Effect, Fiber, Stream } from "effect";
import { makeTelegramAdapter, splitMessage, toInbound } from "./telegram.ts";

const me = { id: 99, username: "VerdandiBot" };
const alice = { id: 1, first_name: "Alice" };
const dm = { id: 1, type: "private" };
const group = { id: -100, type: "supergroup" };

test("updates become facts: a DM, a group mention, a reply with a quote, a topic, a button press, and what isn't for Verdandi", () => {
  const at = (update: object) => toInbound({ update_id: 1, ...update }, me);
  expect(at({ message: { message_id: 1, from: alice, chat: dm, text: "hi" } })).toEqual({
    platform: "telegram",
    chatType: "dm",
    chatId: "1",
    sender: { id: "1", name: "Alice" },
    addressesBot: false,
    text: "hi",
    context: [],
  });
  expect(
    at({
      message: {
        message_id: 2,
        from: alice,
        chat: group,
        text: "@verdandibot look",
        entities: [{ type: "mention", offset: 0, length: 12 }],
      },
    }),
  ).toMatchObject({ chatType: "group", chatId: "-100", addressesBot: true });
  expect(at({ message: { message_id: 3, from: alice, chat: group, text: "just chatting" } })).toMatchObject({ addressesBot: false });
  expect(
    at({
      message: {
        message_id: 4,
        from: alice,
        chat: group,
        text: "and this?",
        quote: { text: "part" },
        reply_to_message: { message_id: 3, from: { id: 2, first_name: "Bob" }, chat: group, text: "the whole part" },
      },
    }),
  ).toMatchObject({
    addressesBot: false,
    context: [
      { kind: "replied", sender: { id: "2", name: "Bob" }, text: "the whole part" },
      { kind: "quoted", sender: { id: "2", name: "Bob" }, text: "part" },
    ],
  });
  expect(
    at({
      message: {
        message_id: 5,
        from: alice,
        chat: group,
        text: "ok",
        reply_to_message: { message_id: 4, from: { id: 99 }, chat: group, text: "Done." },
      },
    }),
  ).toMatchObject({ addressesBot: true, context: [{ kind: "replied", sender: "bot", text: "Done." }] });
  expect(
    at({
      message: { message_id: 6, from: alice, chat: group, text: "/undo-revert@VerdandiBot", is_topic_message: true, message_thread_id: 7 },
    }),
  ).toMatchObject({ command: { name: "undo-revert", args: [] }, addressesBot: true, platformThread: "7" });
  expect(at({ message: { message_id: 7, from: alice, chat: group, text: "/help@OtherBot" } })).toMatchObject({ addressesBot: false });
  expect(at({ callback_query: { id: "q", from: alice, data: "approve r1", message: { message_id: 8, chat: dm } } })).toMatchObject({
    chatType: "dm",
    command: { name: "approve", args: ["r1"] },
    addressesBot: true,
  });
  expect(at({ message: { message_id: 9, from: alice, chat: { id: -5, type: "channel" }, text: "post" } })).toBeUndefined();
});

test("a long reply splits at line ends and closes and reopens a code fence it breaks", () => {
  const code = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const pieces = splitMessage(`Here:\n\`\`\`ts\n${code}\n\`\`\`\nDone.`, 120);
  expect(pieces.length).toBeGreaterThan(2);
  for (const piece of pieces) {
    expect(piece.length).toBeLessThanOrEqual(120);
    expect((piece.match(/^```/gm) ?? []).length % 2).toBe(0);
  }
  expect(pieces.join("\n").replaceAll(/\n```\n```ts/g, "")).toBe(`Here:\n\`\`\`ts\n${code}\n\`\`\`\nDone.`);
  expect(splitMessage("short")).toEqual(["short"]);
  // A line longer than Telegram's limit, inside a fence or opening one, and emoji counted as Telegram counts them.
  for (const text of ["```typescript\n" + "a".repeat(5000) + "\n```", "```" + "x".repeat(5000) + "\nbody\n```", "😀".repeat(3000)]) {
    const parts = splitMessage(text);
    expect(parts.every((p) => p.length <= 4096 && p.trim() !== "```typescript\n```")).toBe(true);
    expect(parts.every((p) => (p.match(/^```/gm) ?? []).length % 2 === 0)).toBe(true);
  }
});

/** A Bot API that answers from `script` by method, recording each call; `getUpdates` hands out one batch, then waits. */
const fakeApi = (script: Record<string, (body: Record<string, unknown>) => object>) => {
  const calls: { method: string; body: Record<string, unknown>; url: string }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    const method = url.split("/").at(-1) ?? "";
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ method, body, url });
    const answer = script[method];
    if (!answer) return new Promise<Response>(() => {});
    return Response.json(answer(body));
  };
  return { calls, fetch };
};

test("the adapter polls for updates, answers button presses, sends with buttons in a topic, and reports a gone chat", async () => {
  let polled = false;
  const api = fakeApi({
    getMe: () => ({ ok: true, result: me }),
    setMyCommands: () => ({ ok: true, result: true }),
    answerCallbackQuery: () => ({ ok: true, result: true }),
    getUpdates: () => {
      if (polled) return { ok: true, result: [] };
      polled = true;
      return {
        ok: true,
        result: [
          { update_id: 10, message: { message_id: 1, from: alice, chat: dm, text: "hello" } },
          { update_id: 11, callback_query: { id: "q1", from: alice, data: "deny r2", message: { message_id: 2, chat: dm } } },
        ],
      };
    },
    sendMessage: (body) =>
      body.chat_id === "404"
        ? { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }
        : { ok: true, result: { message_id: 5 } },
  });
  const token = `123456:${"b".repeat(35)}`;
  const adapter = makeTelegramAdapter({ token, fetch: api.fetch, pollSeconds: 0 });
  const got = await Effect.runPromise(Stream.runCollect(Stream.take(adapter.messages, 2)));
  expect([...got].map((m) => [m.text, m.command?.name])).toEqual([
    ["hello", undefined],
    ["", "deny"],
  ]);
  expect(api.calls.find((c) => c.method === "answerCallbackQuery")?.body).toEqual({ callback_query_id: "q1" });
  expect(api.calls.find((c) => c.method === "setMyCommands")?.body.commands).toContainEqual(expect.objectContaining({ command: "help" }));

  const sent = await Effect.runPromise(
    adapter.send({ chatId: "-100", platformThread: "7", text: "Allow?", buttons: [{ label: "Allow", command: "approve r3" }] }),
  );
  expect(sent).toEqual({ messageId: "5" });
  expect(api.calls.at(-1)?.body).toEqual({
    chat_id: "-100",
    message_thread_id: 7,
    text: "Allow?",
    reply_markup: { inline_keyboard: [[{ text: "Allow", callback_data: "approve r3" }]] },
  });
  const gone = await Effect.runPromise(Effect.flip(adapter.send({ chatId: "404", text: "hi" })));
  expect(gone.gone).toBe(true);
  // No error message carries the token.
  expect(gone.message).not.toContain(token);

  // A poll in flight is cut off when the stream is interrupted.
  const stuck = makeTelegramAdapter({ token, fetch: fakeApi({ getMe: () => ({ ok: true, result: me }) }).fetch });
  const fiber = Effect.runFork(Stream.runDrain(stuck.messages));
  await Effect.runPromise(Fiber.interrupt(fiber));
});
