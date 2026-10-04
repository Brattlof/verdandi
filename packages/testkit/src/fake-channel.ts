import type { InboundMessage, OutboundMessage, Platform, PlatformAdapter } from "@verdandi/contracts";
import { Effect, Queue, Stream } from "effect";

/** A message the fake channel sent, with the id it got. */
export type Sent = OutboundMessage & { readonly messageId: string };

/**
 * A chat app for tests, beside the fake harness: `receive` delivers a message to verdandid as an adapter would report it,
 * and `next` resolves with the next message verdandid sends, so a test waits on it instead of sleeping. A send that
 * `hold` matches never completes, as if verdandid stopped mid-send; `edits` keeps what was edited in place.
 */
export const makeFakeChannel = (options: { readonly platform?: Platform; readonly hold?: (m: OutboundMessage) => boolean } = {}) => {
  const platform = options.platform ?? "fake";
  const inbox = Effect.runSync(Queue.unbounded<InboundMessage>());
  const sent: Sent[] = [];
  const edits: { readonly chatId: string; readonly messageId: string; readonly text: string }[] = [];
  const held: OutboundMessage[] = [];
  const waiting: ((s: Sent) => void)[] = [];
  const heldWaiting: ((m: OutboundMessage) => void)[] = [];
  let read = 0;
  const adapter: PlatformAdapter = {
    platform,
    messages: Stream.fromQueue(inbox),
    send: (message) =>
      options.hold?.(message)
        ? Effect.andThen(
            Effect.sync(() => {
              held.push(message);
              heldWaiting.shift()?.(message);
            }),
            Effect.never,
          )
        : Effect.sync(() => {
            const s = { ...message, messageId: String(sent.length + 1) };
            sent.push(s);
            if (waiting.length > 0) {
              read++;
              waiting.shift()?.(s);
            }
            return { messageId: s.messageId };
          }),
    edit: (chatId, messageId, text) => Effect.sync(() => void edits.push({ chatId, messageId, text })),
  };
  return {
    adapter,
    /** Every message sent so far, oldest first. */
    sent,
    edits,
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
    /** The next message sent that `which` matches (default: any), skipping the others. */
    next: async (which: (s: Sent) => boolean = () => true): Promise<Sent> => {
      for (;;) {
        const queued = sent[read];
        if (queued) read++;
        const s = queued ?? (await new Promise<Sent>((resolve) => waiting.push(resolve)));
        if (which(s)) return s;
      }
    },
    /** Resolves once a send that `hold` matches has started and hangs. */
    nextHeld: () => (held[0] ? Promise.resolve(held[0]) : new Promise<OutboundMessage>((resolve) => heldWaiting.push(resolve))),
  };
};
