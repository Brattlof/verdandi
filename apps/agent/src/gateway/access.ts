import { type ContextText, type InboundMessage, parseSlash, type SlashNameOn, slashEntry } from "@verdandi/contracts";

/**
 * Who may do what through the messaging gateway (DESIGN §15, §17): the only place it's decided. Adapters report facts
 * (`InboundMessage`); this module turns them into one outcome, and nothing here does I/O or reads a clock of its own.
 *
 * Two questions are kept apart. Trigger authorization: may this sender start a turn or run a command here? Context
 * visibility: of the quoted, replied-to and thread text the message carries, which reaches the agent? Only text from
 * senders allowed in the same chat, or from Verdandi itself, and always as untrusted data.
 */

/** One platform's access rules, from `gateway.yaml`. */
export type PlatformAccess = {
  /** DMs from senders not let in yet: `pairing` sends them a code for the owner to approve, `allowlist` ignores them. */
  readonly dm: "pairing" | "allowlist" | "disabled";
  /** Senders let in on every DM without pairing, by the platform's id. */
  readonly allowFrom: readonly string[];
  /**
   * The group chats Verdandi answers in, by chat id, and who in each may start a turn: `senders`, or anyone in it when
   * absent. Pairing in a DM never lets anyone into a group.
   */
  readonly groups: Readonly<Record<string, { readonly senders?: readonly string[] }>>;
};

export const defaultAccess: PlatformAccess = { dm: "pairing", allowFrom: [], groups: {} };

/** What verdandid knows about the platform's senders, loaded before each message. */
export type AccessState = {
  /** The platform's owner, set from the web UI or the CLI; null before one is. */
  readonly owner: string | null;
  /** Senders the owner paired and hasn't revoked. */
  readonly paired: readonly string[];
  /** Pairing requests on the platform that wait and haven't expired. */
  readonly pending: number;
  /** When this sender last asked to pair, if they ever did. */
  readonly lastRequestAt: string | null;
};

export const pairingLimits = {
  /** A code works for an hour. */
  lifetimeMs: 60 * 60_000,
  /** At most this many wait per platform account; more are ignored until one is answered or expires. */
  maxPending: 3,
  /** A sender asks at most once per 10 minutes. */
  intervalMs: 10 * 60_000,
} as const;

export type Access =
  /** Nothing happens and nothing is said; `reason` is for the log. */
  | { readonly kind: "ignore"; readonly reason: string }
  /** Send the sender a pairing code. Their message isn't processed. */
  | { readonly kind: "pair" }
  /** Tell the sender why not, and do nothing else. */
  | { readonly kind: "refuse"; readonly reply: string }
  | { readonly kind: "command"; readonly name: SlashNameOn<"gateway">; readonly args: readonly string[]; readonly owner: boolean }
  /** Start or steer a turn with `text`. `context` is what the agent may see of the rest, as untrusted data. */
  | { readonly kind: "turn"; readonly text: string; readonly context: readonly ContextText[]; readonly owner: boolean };

const ignore = (reason: string): Access => ({ kind: "ignore", reason });

/** Whether `senderId` may start turns in the message's chat. */
const allowedIn = (rules: PlatformAccess, state: AccessState, m: InboundMessage, senderId: string) => {
  if (senderId === state.owner) return true;
  if (m.chatType === "dm") return state.paired.includes(senderId) || rules.allowFrom.includes(senderId);
  const senders = rules.groups[m.chatId]?.senders;
  return senders === undefined || senders.includes(senderId);
};

/** Whether an unknown sender may ask to pair now, under the platform's limits. */
const mayPair = (state: AccessState, now: Date) => {
  if (state.pending >= pairingLimits.maxPending) return `${pairingLimits.maxPending} pairing requests already wait`;
  if (state.lastRequestAt && now.getTime() - Date.parse(state.lastRequestAt) < pairingLimits.intervalMs)
    return "the sender asked to pair less than 10 minutes ago";
  return undefined;
};

export const access = (rules: PlatformAccess, state: AccessState, m: InboundMessage, now: Date): Access => {
  const sender = m.sender.id;
  if (m.chatType === "dm" && rules.dm === "disabled") return ignore("DMs are disabled in gateway.yaml");
  if (m.chatType === "group") {
    if (!Object.hasOwn(rules.groups, m.chatId)) return ignore(`group ${m.chatId} isn't in gateway.yaml's groups`);
    if (!m.addressesBot) return ignore("a group message that neither mentions nor replies to the bot");
  }
  if (!allowedIn(rules, state, m, sender)) {
    if (m.chatType === "group") return ignore(`${sender} may not start turns in group ${m.chatId}`);
    if (rules.dm === "allowlist") return ignore(`${sender} isn't on gateway.yaml's allowFrom`);
    const limited = mayPair(state, now);
    return limited ? ignore(`${sender} can't pair: ${limited}`) : { kind: "pair" };
  }
  const owner = sender === state.owner;
  if (m.command) {
    const command = parseSlash(`/${[m.command.name, ...m.command.args].join(" ")}`, "gateway");
    if (!command) return { kind: "refuse", reply: `There's no /${m.command.name} here. /help lists the commands.` };
    if (slashEntry(command.name).ownerOnly && !owner) return { kind: "refuse", reply: `Only the owner can use /${command.name}.` };
    return { kind: "command", name: command.name, args: command.args, owner };
  }
  const context = m.context.filter((c) => c.sender === "bot" || allowedIn(rules, state, m, c.sender.id));
  return { kind: "turn", text: m.text, context, owner };
};
