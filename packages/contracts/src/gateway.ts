import { Data, type Effect, Schema, type Stream } from "effect";
import { CommandId, ThreadId, TurnId } from "./ids.ts";

/**
 * The messaging gateway (DESIGN §15). A `PlatformAdapter` reports what it sees in a chat app as facts; one pure module in
 * verdandid (`apps/agent/src/gateway/access.ts`) decides who may do what with them, so no adapter makes an
 * authorization decision. A sender the owner hasn't let in pairs: they get a code in their DM, and the owner approves it
 * from the web UI or the CLI, never from a chat. Only a salted hash of the code is kept.
 */
export const Platform = Schema.Literals(["telegram", "fake"]);
export type Platform = typeof Platform.Type;

/** Someone in a chat, by the platform's id for them. `name` is what the platform shows: a hint, never checked. */
export type Sender = { readonly id: string; readonly name: string };

/**
 * Text a message carries from elsewhere: a message it quotes, the one it replies to, or earlier messages of its
 * platform thread, each with who wrote it (`bot`: Verdandi itself). Untrusted data, and the access module decides which
 * of it the agent sees.
 */
export type ContextText = { readonly kind: "quoted" | "replied" | "thread"; readonly sender: Sender | "bot"; readonly text: string };

/** What an adapter reports about one incoming message or button press: facts only. */
export type InboundMessage = {
  readonly platform: Platform;
  readonly chatType: "dm" | "group";
  readonly chatId: string;
  readonly sender: Sender;
  /** The message mentions the bot or replies to one of its messages. */
  readonly addressesBot: boolean;
  /** A slash command (`/name args`), or a button press read as one, e.g. `approve <request>`. */
  readonly command?: { readonly name: string; readonly args: readonly string[] };
  readonly text: string;
  readonly context: readonly ContextText[];
  /** The platform's own thread inside the chat, e.g. a Telegram forum topic. */
  readonly platformThread?: string;
};

/** A button under a message: pressing it comes back as the command line `command`, e.g. `approve <request>`. */
export const Button = Schema.Struct({ label: Schema.String, command: Schema.String });
export type Button = typeof Button.Type;

/** A message to a chat, in its platform thread when it has one. */
export type OutboundMessage = {
  readonly chatId: string;
  readonly platformThread?: string;
  readonly text: string;
  readonly buttons?: readonly Button[];
};

/** A chat app couldn't be reached, or refused a message. `gone`: the chat is gone (left, blocked, deleted), so retrying won't help. */
export class ChannelError extends Data.TaggedError("ChannelError")<{ readonly message: string; readonly gone?: boolean }> {}

/** One chat app, connected outbound only (DESIGN §15). */
export interface PlatformAdapter {
  readonly platform: Platform;
  /** Incoming messages, as facts, until verdandid stops. */
  readonly messages: Stream.Stream<InboundMessage, ChannelError>;
  /** Sends a message, split at the platform's length limit, never inside a code fence; the id is the last part's. */
  readonly send: (message: OutboundMessage) => Effect.Effect<{ readonly messageId: string }, ChannelError>;
  /** Replaces the text of a message it sent, e.g. a turn's progress line. */
  readonly edit: (chatId: string, messageId: string, text: string) => Effect.Effect<void, ChannelError>;
}

/**
 * How chats map to conversations (DESIGN §15), after Hermes's defaults: a DM is its own conversation; in a group each
 * sender gets their own (`per-sender`) or all share one (`shared`); a platform thread is shared by its participants.
 */
export type IsolationPolicy = { readonly group: "per-sender" | "shared"; readonly platformThread: "shared" | "per-sender" };
export const defaultIsolation: IsolationPolicy = { group: "per-sender", platformThread: "shared" };

/**
 * The binding key of the conversation a message belongs to: one Verdandi thread per key. `shared` when more than one
 * sender can write in it, so each message names its sender.
 */
export const bindingKey = (
  m: Pick<InboundMessage, "platform" | "chatType" | "chatId" | "platformThread"> & { readonly senderId: string },
  policy: IsolationPolicy = defaultIsolation,
) => {
  const part = encodeURIComponent;
  const chat = `${m.platform}:${part(m.chatId)}`;
  const sender = `:sender:${part(m.senderId)}`;
  if (m.chatType === "dm") return { key: chat, shared: false };
  if (m.platformThread !== undefined) {
    const thread = `${chat}:thread:${part(m.platformThread)}`;
    return policy.platformThread === "shared" ? { key: thread, shared: true } : { key: `${thread}${sender}`, shared: false };
  }
  return policy.group === "shared" ? { key: chat, shared: true } : { key: `${chat}${sender}`, shared: false };
};

/** Where a bound thread's replies go: only there, never somewhere the agent names. */
export const ChannelBinding = Schema.Struct({
  key: Schema.String,
  platform: Platform,
  chatId: Schema.String,
  platformThread: Schema.NullOr(Schema.String),
});
export type ChannelBinding = typeof ChannelBinding.Type;

/**
 * Internal: the gateway binds a conversation's key to a thread. `confined`: a sender other than the platform's owner can
 * write in it, so its turns get none of `workspace.yaml`'s folders (DESIGN §23, question 10).
 */
export const ChannelBind = Schema.Struct({
  type: Schema.Literal("channel.bind"),
  commandId: CommandId,
  threadId: ThreadId,
  binding: ChannelBinding,
  confined: Schema.Boolean,
});
/** Stops the thread replying to its chat; the chat's next message starts a new thread. */
export const ChannelUnbind = Schema.Struct({ type: Schema.Literal("channel.unbind"), commandId: CommandId, threadId: ThreadId });
export const ChannelBound = Schema.Struct({
  type: Schema.Literal("channel.bound"),
  v: Schema.Literal(1),
  threadId: ThreadId,
  binding: ChannelBinding,
  confined: Schema.Boolean,
});
export const ChannelUnbound = Schema.Struct({
  type: Schema.Literal("channel.unbound"),
  v: Schema.Literal(1),
  threadId: ThreadId,
  key: Schema.String,
});

/**
 * The outbox (DESIGN §15): a bound thread's final reply, or a request waiting for an answer, committed with the turn's
 * own event. `deliveryId` is `reply:<turn>` or `request:<request>`.
 */
export const DeliveryRequested = Schema.Struct({
  type: Schema.Literal("delivery.requested"),
  v: Schema.Literal(1),
  threadId: ThreadId,
  deliveryId: Schema.String,
  turnId: TurnId,
  binding: ChannelBinding,
  text: Schema.String,
  buttons: Schema.Array(Button),
});
/** About to send; `duplicate`: an earlier attempt never reported back, so the chat may already have it. */
export const DeliveryAttempted = Schema.Struct({
  type: Schema.Literal("delivery.attempted"),
  v: Schema.Literal(1),
  threadId: ThreadId,
  deliveryId: Schema.String,
  attempt: Schema.Number,
  duplicate: Schema.Boolean,
});
export const DeliveryReported = Schema.Struct({
  type: Schema.Literal("delivery.reported"),
  v: Schema.Literal(1),
  threadId: ThreadId,
  deliveryId: Schema.String,
  outcome: Schema.Literals(["sent", "failed"]),
  messageId: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
/** Given up after `deliveryLimits`, or at once for a chat that's gone; shown on the turn. */
export const DeliveryAbandoned = Schema.Struct({
  type: Schema.Literal("delivery.abandoned"),
  v: Schema.Literal(1),
  threadId: ThreadId,
  deliveryId: Schema.String,
  turnId: TurnId,
  reason: Schema.String,
});
/** Internal: the outbox's steps, which the gateway sends. */
export const DeliveryAttempt = Schema.Struct({
  type: Schema.Literal("delivery.attempt"),
  commandId: CommandId,
  threadId: ThreadId,
  deliveryId: Schema.String,
});
export const DeliveryReport = Schema.Struct({
  type: Schema.Literal("delivery.report"),
  commandId: CommandId,
  threadId: ThreadId,
  deliveryId: Schema.String,
  outcome: Schema.Literals(["sent", "failed"]),
  messageId: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});
export const DeliveryAbandon = Schema.Struct({
  type: Schema.Literal("delivery.abandon"),
  commandId: CommandId,
  threadId: ThreadId,
  deliveryId: Schema.String,
  reason: Schema.String,
});

/** At most this many attempts, within this long after the delivery was requested, before it's abandoned. */
export const deliveryLimits = { attempts: 3, withinMs: 24 * 60 * 60_000 } as const;

/**
 * Internal: an unknown sender asked to pair in a DM. verdandid makes the code and sends it to that DM only; the command
 * and its event carry only the code's salted SHA-256 (`codeHash`, hex) and its salt.
 */
export const GatewayPairingRequest = Schema.Struct({
  type: Schema.Literal("pairing.request"),
  commandId: CommandId,
  requestId: Schema.String,
  platform: Platform,
  chatId: Schema.String,
  senderId: Schema.String,
  senderName: Schema.String,
  codeHash: Schema.String,
  salt: Schema.String,
  expiresAt: Schema.String,
});
/** Lets the sender who raised `requestId` in; with `owner`, also makes them the platform's owner. */
export const PairingApprove = Schema.Struct({
  type: Schema.Literal("pairing.approve"),
  commandId: CommandId,
  requestId: Schema.String,
  owner: Schema.Boolean,
});
export const PairingDeny = Schema.Struct({ type: Schema.Literal("pairing.deny"), commandId: CommandId, requestId: Schema.String });
/** Takes a paired sender's access away; a revoked owner stops being the owner. */
export const SenderRevoke = Schema.Struct({
  type: Schema.Literal("sender.revoke"),
  commandId: CommandId,
  platform: Platform,
  senderId: Schema.String,
});
/** Sets who owns the profile on a platform, or with null clears it. Only from the web UI or the CLI, never a chat. */
export const GatewayOwnerSet = Schema.Struct({
  type: Schema.Literal("gateway.owner.set"),
  commandId: CommandId,
  platform: Platform,
  senderId: Schema.NullOr(Schema.String),
});

/** On `profileStream`. Never the code: `codeHash` is its salted SHA-256. */
export const PairingRequested = Schema.Struct({
  type: Schema.Literal("pairing.requested"),
  v: Schema.Literal(1),
  threadId: ThreadId,
  requestId: Schema.String,
  platform: Platform,
  chatId: Schema.String,
  senderId: Schema.String,
  senderName: Schema.String,
  codeHash: Schema.String,
  salt: Schema.String,
  expiresAt: Schema.String,
});
export const PairingApproved = Schema.Struct({
  type: Schema.Literal("pairing.approved"),
  v: Schema.Literal(1),
  threadId: ThreadId,
  requestId: Schema.String,
  platform: Platform,
  chatId: Schema.String,
  senderId: Schema.String,
  senderName: Schema.String,
});
export const PairingDenied = Schema.Struct({
  type: Schema.Literal("pairing.denied"),
  v: Schema.Literal(1),
  threadId: ThreadId,
  requestId: Schema.String,
});
export const SenderRevoked = Schema.Struct({
  type: Schema.Literal("sender.revoked"),
  v: Schema.Literal(1),
  threadId: ThreadId,
  platform: Platform,
  senderId: Schema.String,
});
export const GatewayOwnerChanged = Schema.Struct({
  type: Schema.Literal("gateway.owner.changed"),
  v: Schema.Literal(1),
  threadId: ThreadId,
  platform: Platform,
  senderId: Schema.NullOr(Schema.String),
});

/** A sender waiting for the owner to approve them, as the web UI and `verdandi gateway senders` show it. Never the code. */
export const PendingPairing = Schema.Struct({
  requestId: Schema.String,
  platform: Platform,
  senderId: Schema.String,
  senderName: Schema.String,
  at: Schema.String,
  expiresAt: Schema.String,
});
export type PendingPairing = typeof PendingPairing.Type;

/** Someone with access on a platform: paired (`pairedAt`), the owner, or both. `gateway.yaml`'s `allowFrom` isn't listed. */
export const GatewaySender = Schema.Struct({
  platform: Platform,
  senderId: Schema.String,
  name: Schema.String,
  pairedAt: Schema.NullOr(Schema.String),
  owner: Schema.Boolean,
});
export type GatewaySender = typeof GatewaySender.Type;

/** Pairing requests that wait, oldest first, who has access, and the platforms this verdandid runs (none unless always-on). */
export const GatewayView = Schema.Struct({
  pending: Schema.Array(PendingPairing),
  senders: Schema.Array(GatewaySender),
  running: Schema.Array(Platform),
});
export type GatewayView = typeof GatewayView.Type;

/** Why a pairing code can't be approved. The message names the cause and the fix. */
export class GatewayUnavailable extends Schema.TaggedError<GatewayUnavailable>()("GatewayUnavailable", {
  reason: Schema.Literals(["PairingNotFound"]),
  message: Schema.String,
}) {}

/** A pairing code's letters: no 0, O, 1 or I, so it's read back without mistakes. */
export const pairingAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const pairingCodeLength = 8;

/** A code as typed, made comparable: spaces and dashes out, upper case. */
export const normalizeCode = (code: string) => code.replaceAll(/[\s-]/g, "").toUpperCase();
