import { Schema } from "effect";
import { CommandId, ThreadId } from "./ids.ts";

/**
 * Paired devices (ADR 0028). A client that holds neither the profile's token nor a page token from `verdandi web` pairs:
 * it asks over verdandid's `/pair` socket, the owner approves from a client that already has access, and verdandid
 * hands it a device token over that socket. Only the token's SHA-256 hash is kept, in `device.paired`.
 */
export const DeviceId = Schema.String.pipe(Schema.brand("DeviceId"));
export type DeviceId = typeof DeviceId.Type;

/** Internal: records a device the owner approved, with its token's hash. verdandid makes the token; clients cannot send it. */
export const DevicePair = Schema.Struct({
  type: Schema.Literal("device.pair"),
  commandId: CommandId,
  deviceId: DeviceId,
  name: Schema.String,
  tokenHash: Schema.String,
});
/** Cuts a device off: its token stops working and its open connections close. */
export const DeviceRevoke = Schema.Struct({ type: Schema.Literal("device.revoke"), commandId: CommandId, deviceId: DeviceId });

/** On `profileStream`. `tokenHash` is the SHA-256 of the device's token, never the token. */
export const DevicePaired = Schema.Struct({
  type: Schema.Literal("device.paired"),
  v: Schema.Literal(1),
  threadId: ThreadId,
  deviceId: DeviceId,
  name: Schema.String,
  tokenHash: Schema.String,
});
export const DeviceRevoked = Schema.Struct({
  type: Schema.Literal("device.revoked"),
  v: Schema.Literal(1),
  threadId: ThreadId,
  deviceId: DeviceId,
});

/** A paired device, as the Devices list shows it. `lastSeen` is when it last connected; null if it never has. */
export const DeviceView = Schema.Struct({
  deviceId: DeviceId,
  name: Schema.String,
  pairedAt: Schema.String,
  lastSeen: Schema.NullOr(Schema.String),
  revoked: Schema.Boolean,
});
export type DeviceView = typeof DeviceView.Type;

/**
 * A device asking to pair. Its address and user agent are what it, or the web server relaying it, reported: hints only.
 * The code is the check: the owner approves when the device shows the same one.
 */
export const PairingRequest = Schema.Struct({
  requestId: Schema.String,
  code: Schema.String,
  name: Schema.String,
  address: Schema.String,
  userAgent: Schema.String,
  at: Schema.String,
});
export type PairingRequest = typeof PairingRequest.Type;

/** Every paired device, revoked ones included, and the pairing requests that wait, oldest first. */
export const DevicesView = Schema.Struct({ devices: Schema.Array(DeviceView), pending: Schema.Array(PairingRequest) });
export type DevicesView = typeof DevicesView.Type;

/** What verdandid's `/pair` socket sends, as JSON text frames: the request, then how it ended. The socket closes after either end. */
export type PairMessage =
  | { readonly kind: "pending"; readonly requestId: string; readonly code: string }
  | { readonly kind: "approved"; readonly deviceId: DeviceId; readonly token: string }
  | { readonly kind: "refused"; readonly message: string };

/** Why a pairing request can't be answered. The message names the cause and the fix. */
export class DevicesUnavailable extends Schema.TaggedError<DevicesUnavailable>()("DevicesUnavailable", {
  reason: Schema.Literals(["RequestNotFound"]),
  message: Schema.String,
}) {}

/** At most this many pairing requests wait at once; another is refused until one is answered or withdrawn. */
export const maxPendingPairings = 3;

/** A short name for a device from its user agent, e.g. `Safari on iPhone`; the user agent itself when nothing matches. */
export const deviceName = (userAgent: string) => {
  const os = /iPhone|iPad|Android|Windows|Mac OS X|Linux/.exec(userAgent)?.[0]?.replace("Mac OS X", "macOS");
  // In order: Edge's and Chrome's user agents also say Safari, and Edge's says Chrome.
  const browser = browsers.find(([marker]) => userAgent.includes(marker))?.[1];
  const label = [browser, os && `on ${os}`].filter(Boolean).join(" ");
  return label || userAgent.slice(0, 80) || "Unknown device";
};
const browsers = [
  ["Edg/", "Edge"],
  ["Firefox/", "Firefox"],
  ["Chrome/", "Chrome"],
  ["Safari/", "Safari"],
] as const;
