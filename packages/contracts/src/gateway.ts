import { Data, type Effect, Schema, type Stream } from "effect";
import { CommandId, ThreadId } from "./ids.ts";

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
};

/** A chat app couldn't be reached, or refused a message. */
export class ChannelError extends Data.TaggedError("ChannelError")<{ readonly message: string }> {}

/** One chat app, connected outbound only (DESIGN §15). */
export interface PlatformAdapter {
  readonly platform: Platform;
  /** Incoming messages, as facts, until verdandid stops. */
  readonly messages: Stream.Stream<InboundMessage, ChannelError>;
  readonly send: (chatId: string, text: string) => Effect.Effect<void, ChannelError>;
}

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
