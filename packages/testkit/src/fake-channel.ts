import type { InboundMessage, Platform, PlatformAdapter } from "@verdandi/contracts";
import { Effect, Queue, Stream } from "effect";

/** A message the fake channel sent. */
export type Sent = { readonly chatId: string; readonly text: string };

/**
 * A chat app for tests, beside the fake harness: `receive` delivers a message to verdandid as an adapter would report it,
 * and `next` resolves with the next message verdandid sends, so a test waits on it instead of sleeping.
 */
export const makeFakeChannel = (platform: Platform = "fake") => {
  const inbox = Effect.runSync(Queue.unbounded<InboundMessage>());
  const sent: Sent[] = [];
  const waiting: ((s: Sent) => void)[] = [];
  let read = 0;
  const adapter: PlatformAdapter = {
    platform,
    messages: Stream.fromQueue(inbox),
    send: (chatId, text) =>
      Effect.sync(() => {
        const s = { chatId, text };
        sent.push(s);
        if (waiting.length > 0) {
          read++;
          waiting.shift()?.(s);
        }
      }),
  };
  return {
    adapter,
    /** Every message sent so far, oldest first. */
    sent,
    /** A DM from `sender` unless `message` says otherwise. */
    receive: (sender: { readonly id: string; readonly name: string }, text: string, message: Partial<InboundMessage> = {}) =>
      void Queue.offerUnsafe(inbox, {
        platform,
        chatType: "dm",
        chatId: sender.id,
        sender,
        addressesBot: true,
        text,
        context: [],
        ...message,
      }),
    next: () => {
      const queued = sent[read];
      if (queued) {
        read++;
        return Promise.resolve(queued);
      }
      return new Promise<Sent>((resolve) => waiting.push(resolve));
    },
  };
};
