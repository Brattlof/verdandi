import {
  ChannelError,
  type ContextText,
  codePointStart,
  type InboundMessage,
  type OutboundMessage,
  type PlatformAdapter,
  type Sender,
  slashCommands,
  slashNamesOn,
} from "@verdandi/contracts";
import type { SecretStore } from "@verdandi/harness-native";
import { Effect, Option, Stream } from "effect";

/**
 * Telegram over its Bot API with plain `fetch` (DESIGN §23, question 5): long polling with `getUpdates`, so no port
 * opens, and inline keyboards for requests. The adapter only reports facts and sends; `access.ts` decides. The bot's
 * token is in every request's URL, so no error message here ever carries a URL or the token.
 */

/** Where the bot token lives: this variable (Bun loads `.env`), else the OS keychain (`verdandi key set telegram`). */
export const telegramTokenVariable = "VERDANDI_TELEGRAM_BOT_TOKEN";
export const telegramKeychainEntry = { service: "verdandi", name: "telegram-bot-token" } as const;

/** Why `token` can't be a bot token, or undefined when it looks like one. Never quotes the token. */
export const telegramTokenProblem = (token: string) =>
  /^\d+:[\w-]{30,}$/.test(token)
    ? undefined
    : "it doesn't look like a bot token from @BotFather (digits, a colon, then 30 or more letters)";

/**
 * The bot token: `VERDANDI_TELEGRAM_BOT_TOKEN`, else the OS keychain. With neither, or a keychain that can't be read,
 * `token` is undefined and `reason` says how to add one. One that's there but malformed throws, naming where it is and
 * the fix. No message ever holds the token.
 */
export const findTelegramToken = async (
  env: Readonly<Record<string, string | undefined>>,
  secrets: SecretStore,
): Promise<{ readonly token: string; readonly source: string } | { readonly token: undefined; readonly reason: string }> => {
  const fromEnv = env[telegramTokenVariable]?.trim();
  if (fromEnv !== undefined) {
    const problem = telegramTokenProblem(fromEnv);
    if (problem) throw new Error(`${telegramTokenVariable} is set, but ${problem}. Fix it in your environment or .env, or unset it.`);
    return { token: fromEnv, source: telegramTokenVariable };
  }
  let stored: string | null;
  try {
    stored = await secrets.get(telegramKeychainEntry);
  } catch (e) {
    return { token: undefined, reason: `the OS keychain can't be read (${e instanceof Error ? e.message : String(e)})` };
  }
  if (stored === null)
    return { token: undefined, reason: `no bot token: add one with verdandi key set telegram, or set ${telegramTokenVariable}` };
  const problem = telegramTokenProblem(stored);
  if (problem)
    throw new Error(`The Telegram bot token in the OS keychain is unusable: ${problem}. Replace it with verdandi key set telegram.`);
  return { token: stored, source: "the OS keychain" };
};

/** Telegram's limit on one message's text. */
const maxLength = 4096;

/**
 * `text` in pieces of at most `limit` characters, broken at line ends. A code fence a break falls inside is closed at the
 * end of one piece and opened again at the start of the next, so no piece leaves a fence open.
 */
export const splitMessage = (text: string, limit = maxLength): string[] => {
  const close = "```";
  // A piece is at most: the reopened fence (at most 16 characters), a line, and the closing fence, with their line ends.
  const room = limit - 16 - close.length - 2;
  // Sizes count UTF-16 units, as Telegram does; a long line is cut in parts, never inside a surrogate pair.
  const cut = (line: string): string[] => {
    if (line.length <= room) return [line];
    const at = codePointStart(line, room);
    return [line.slice(0, at), ...cut(line.slice(at))];
  };
  const pieces: string[] = [];
  let piece: string[] = [];
  let size = -1; // the piece's length joined, -1 while it's empty
  let fence: string | undefined;
  const start = (lines: string[]) => {
    piece = lines;
    size = lines.join("\n").length - (lines.length === 0 ? 1 : 0);
  };
  for (const line of text.split("\n").flatMap(cut)) {
    // The piece with this line, and the fence closed after it if one is open by then.
    const closing = fence !== undefined || line.startsWith(close) ? close.length + 1 : 0;
    const reopenedOnly = fence !== undefined && piece.length === 1 && piece[0] === fence;
    if (piece.length > 0 && !reopenedOnly && size + 1 + line.length + closing > limit) {
      pieces.push([...piece, ...(fence === undefined ? [] : [close])].join("\n"));
      start(fence === undefined ? [] : [fence]);
    }
    piece.push(line);
    size += 1 + line.length;
    if (fence === undefined && line.startsWith(close)) fence = (/^`{3,}\S{0,12}/.exec(line)?.[0] ?? close).slice(0, 16);
    else if (fence !== undefined && line.trim() === close) fence = undefined;
  }
  if (piece.length > 0) pieces.push(piece.join("\n"));
  return pieces;
};

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type TelegramUser = { readonly id: number; readonly first_name?: string; readonly last_name?: string; readonly username?: string };
type TelegramMessage = {
  readonly message_id: number;
  readonly message_thread_id?: number;
  readonly is_topic_message?: boolean;
  readonly from?: TelegramUser;
  readonly chat: { readonly id: number; readonly type: string };
  readonly text?: string;
  readonly caption?: string;
  readonly entities?: readonly { readonly type: string; readonly offset: number; readonly length: number; readonly user?: TelegramUser }[];
  readonly reply_to_message?: TelegramMessage & { readonly forum_topic_created?: unknown };
  readonly quote?: { readonly text: string };
};
type Update = {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly callback_query?: {
    readonly id: string;
    readonly from: TelegramUser;
    readonly data?: string;
    readonly message?: TelegramMessage;
  };
};

const senderOf = (u: TelegramUser): Sender => ({
  id: String(u.id),
  name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id),
});
const chatTypes: Record<string, InboundMessage["chatType"]> = { private: "dm", group: "group", supergroup: "group" };
const topic = (m: TelegramMessage) =>
  m.is_topic_message && m.message_thread_id !== undefined ? { platformThread: String(m.message_thread_id) } : {};

/** A command line's name and words: `/name@bot a b`, unless it names another bot. */
const parseCommand = (text: string, bot: string) => {
  const match = /^\/([\w-]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return undefined;
  const [, name = "", to, rest = ""] = match;
  if (to !== undefined && to.toLowerCase() !== bot.toLowerCase()) return "other";
  return { name: name.toLowerCase(), args: rest.split(/\s+/).filter(Boolean) };
};

/** The facts of one update, or undefined for one Verdandi doesn't take (a channel post, an edit, a service message). */
export const toInbound = (update: Update, me: { readonly id: number; readonly username: string }): InboundMessage | undefined => {
  const press = update.callback_query;
  if (press?.message && press.data) {
    const chatType = chatTypes[press.message.chat.type];
    const command = parseCommand(`/${press.data}`, me.username);
    if (!chatType || !command || command === "other") return undefined;
    return {
      platform: "telegram",
      chatType,
      chatId: String(press.message.chat.id),
      sender: senderOf(press.from),
      addressesBot: true,
      command,
      text: "",
      context: [],
      ...topic(press.message),
    };
  }
  const m = update.message;
  const chatType = m && chatTypes[m.chat.type];
  if (!m?.from || !chatType) return undefined;
  const text = m.text ?? m.caption ?? "";
  const command = parseCommand(text, me.username);
  const replied = m.reply_to_message && !m.reply_to_message.forum_topic_created ? m.reply_to_message : undefined;
  const repliedSender: Sender | "bot" | undefined = replied?.from && (replied.from.id === me.id ? "bot" : senderOf(replied.from));
  const mentions = (m.entities ?? []).some(
    (e) =>
      (e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${me.username.toLowerCase()}`) ||
      (e.type === "text_mention" && e.user?.id === me.id),
  );
  const context: ContextText[] = [
    ...(replied && repliedSender ? [{ kind: "replied" as const, sender: repliedSender, text: replied.text ?? replied.caption ?? "" }] : []),
    ...(m.quote && repliedSender ? [{ kind: "quoted" as const, sender: repliedSender, text: m.quote.text }] : []),
  ];
  return {
    platform: "telegram",
    chatType,
    chatId: String(m.chat.id),
    sender: senderOf(m.from),
    addressesBot: mentions || repliedSender === "bot" || (command !== undefined && command !== "other"),
    ...(command && command !== "other" && { command }),
    text,
    context,
    ...topic(m),
  };
};

/** Errors that mean the chat is gone for good: the bot was blocked or removed, or the chat no longer exists. */
const goneError = (code: number, description: string) =>
  code === 403 || (code === 400 && /chat not found|chat_id is empty|group chat was deactivated/i.test(description));

/** The commands Telegram's menu lists: the registry's gateway commands whose names it accepts, less the request buttons. */
export const telegramMenu = () =>
  slashNamesOn("gateway")
    .filter((name) => /^[a-z0-9_]{1,32}$/.test(name) && !slashCommands[name].args.some((a) => a.name === "request"))
    .map((name) => ({ command: name, description: slashCommands[name].help.slice(0, 256) }));

export const makeTelegramAdapter = (options: {
  readonly token: string;
  readonly fetch?: Fetch;
  readonly pollSeconds?: number;
}): PlatformAdapter => {
  const fetchFn: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const call = <A>(method: string, body: object) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetchFn(`https://api.telegram.org/bot${options.token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        return (await response.json()) as
          | { readonly ok: true; readonly result: A }
          | { readonly ok: false; readonly error_code: number; readonly description: string };
      },
      catch: (e) => new ChannelError({ message: `Couldn't reach Telegram (${e instanceof Error ? e.name : "error"}).` }),
    }).pipe(
      Effect.flatMap((r) =>
        r.ok
          ? Effect.succeed(r.result)
          : Effect.fail(
              new ChannelError({ message: `Telegram refused ${method}: ${r.description}`, gone: goneError(r.error_code, r.description) }),
            ),
      ),
    );

  // The next update to ask for: Telegram forgets the ones before it once a poll asks from here.
  let offset = 0;
  const messages = Stream.unwrap(
    Effect.gen(function* () {
      const me = yield* call<{ id: number; username: string }>("getMe", {});
      yield* call("setMyCommands", { commands: telegramMenu() }).pipe(
        Effect.ignoreCause({ log: "Warn", message: "Couldn't set Telegram's command menu." }),
      );
      return Stream.paginate(offset, (from: number) =>
        Effect.gen(function* () {
          const updates = yield* call<Update[]>("getUpdates", {
            offset: from,
            timeout: options.pollSeconds ?? 30,
            allowed_updates: ["message", "callback_query"],
          });
          // A button press is acknowledged at once, so the user's spinner stops; what it does comes as a message.
          yield* Effect.forEach(
            updates.flatMap((u) => (u.callback_query ? [u.callback_query.id] : [])),
            (id) => call("answerCallbackQuery", { callback_query_id: id }).pipe(Effect.ignore),
            { discard: true },
          );
          // Kept past a reconnect, so a batch already handed over isn't fetched again when the next poll fails.
          offset = Math.max(from, ...updates.map((u) => u.update_id + 1));
          const next = offset;
          return [updates.flatMap((u) => toInbound(u, me) ?? []), Option.some(next)] as const;
        }),
      );
    }),
  );

  const send = (message: OutboundMessage) =>
    Effect.gen(function* () {
      // A button's data is at most 64 bytes; one that doesn't fit is offered as the command to type instead.
      const fits = (command: string) => new TextEncoder().encode(command).length <= 64;
      const buttons = message.buttons?.filter((b) => fits(b.command)) ?? [];
      const typed = (message.buttons ?? []).filter((b) => !fits(b.command)).map((b) => `${b.label}: /${b.command}`);
      const pieces = splitMessage([message.text || " ", ...typed].join("\n\n"));
      let last = "";
      for (const [i, text] of pieces.entries()) {
        const keyboard =
          i === pieces.length - 1 && buttons.length > 0
            ? { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.label, callback_data: b.command }))] } }
            : {};
        const sent = yield* call<{ message_id: number }>("sendMessage", {
          chat_id: message.chatId,
          ...(message.platformThread !== undefined && { message_thread_id: Number(message.platformThread) }),
          text,
          ...keyboard,
        });
        last = String(sent.message_id);
      }
      return { messageId: last };
    });

  const edit = (chatId: string, messageId: string, text: string) =>
    call("editMessageText", { chat_id: chatId, message_id: Number(messageId), text: splitMessage(text)[0] ?? text }).pipe(
      Effect.asVoid,
      // Editing to the same text isn't a failure.
      Effect.catchIf(
        (e) => e.message.includes("message is not modified"),
        () => Effect.void,
      ),
    );

  return { platform: "telegram", messages, send, edit };
};
