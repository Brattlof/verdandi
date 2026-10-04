import type { ClientCommand } from "./commands.ts";
import type { TaskRating } from "./task.ts";

/** Where a slash command can be typed: the terminal chat (the terminal UI and `--plain`), the web composer, a chat app. */
export type Surface = "chat" | "web" | "gateway";

/** One argument: `choices` lists the words it takes, for completion and a chat app's option menu. */
export type SlashArg = { readonly name: string; readonly optional?: true; readonly choices?: readonly string[] };

/**
 * What a command does while the thread's turn runs. `run`: at once, ahead of the turn, and it never answers a waiting
 * request. `queue`: it only changes what the next turn carries (a mode, attachments), so it takes effect after the turn.
 * `refuse`: not while a turn runs, saying why and when it works; the decider rejects its command then too.
 */
export type WhileBusy = "run" | "queue" | { readonly refuse: string };

export type SlashEntry = {
  readonly args: readonly SlashArg[];
  /** One line of help. */
  readonly help: string;
  readonly surfaces: readonly Surface[];
  /** In a chat app, only the profile's owner may use it. */
  readonly ownerOnly: boolean;
  /** The client commands it dispatches; none when it stays in the client, like `/diff`. */
  readonly dispatches: readonly ClientCommand["type"][];
  readonly whileBusy: WhileBusy;
};

const modeSwitch = (help: string) =>
  ({
    args: [],
    help,
    surfaces: ["chat", "web", "gateway"],
    ownerOnly: true,
    dispatches: [],
    whileBusy: "queue",
  }) as const satisfies SlashEntry;

/**
 * Every slash command, defined once for every surface (#214). Each surface handles its commands through a `Record`
 * keyed by `SlashNameOn<surface>`, so a command added here without a handler fails typecheck there.
 */
export const slashCommands = {
  help: {
    args: [],
    help: "lists these commands",
    surfaces: ["chat", "gateway"],
    ownerOnly: false,
    dispatches: [],
    whileBusy: "run",
  },
  ask: modeSwitch("switches to ask mode: the agent answers without changing anything"),
  plan: modeSwitch("switches to plan mode: the agent proposes a plan for you to approve first"),
  build: modeSwitch("switches to build mode: the agent does the work"),
  attach: {
    args: [{ name: "path" }],
    help: "sends a file or image with your next message",
    surfaces: ["chat"],
    ownerOnly: true,
    dispatches: [],
    whileBusy: "queue",
  },
  detach: {
    args: [],
    help: "drops the files /attach added",
    surfaces: ["chat"],
    ownerOnly: true,
    dispatches: [],
    whileBusy: "queue",
  },
  diff: {
    args: [{ name: "all", optional: true, choices: ["all"] }],
    help: "shows the last turn's edits; /diff all the project's since the thread began",
    surfaces: ["chat", "gateway"],
    ownerOnly: true,
    dispatches: [],
    whileBusy: "run",
  },
  new: {
    args: [],
    help: "starts a new conversation here; the old thread stays in Verdandi",
    surfaces: ["gateway"],
    ownerOnly: false,
    dispatches: ["channel.unbind"],
    whileBusy: "run",
  },
  unbind: {
    args: [],
    help: "stops this thread replying to the chat it's bound to; the chat's next message starts a new thread",
    surfaces: ["chat"],
    ownerOnly: true,
    dispatches: ["channel.unbind"],
    whileBusy: "run",
  },
  approve: {
    args: [{ name: "request" }],
    help: "allows what the agent asked: a request's Approve button",
    surfaces: ["gateway"],
    ownerOnly: true,
    dispatches: ["approval.respond"],
    whileBusy: "run",
  },
  deny: {
    args: [{ name: "request" }],
    help: "denies what the agent asked: a request's Deny button",
    surfaces: ["gateway"],
    ownerOnly: true,
    dispatches: ["approval.respond"],
    whileBusy: "run",
  },
  skip: {
    args: [],
    help: "declines the agent's question",
    surfaces: ["chat", "gateway"],
    ownerOnly: true,
    dispatches: ["approval.respond"],
    whileBusy: "run",
  },
  rate: {
    args: [{ name: "rating", choices: ["up", "down", "clear"] }],
    help: "rates the latest task; clear takes the rating back",
    surfaces: ["chat", "web", "gateway"],
    ownerOnly: true,
    dispatches: ["task.rate"],
    whileBusy: "run",
  },
  "forget-routing": {
    args: [],
    help: "clears what the router learned from this project's tasks",
    surfaces: ["chat", "web"],
    ownerOnly: true,
    dispatches: ["routing.memory.clear"],
    whileBusy: "run",
  },
  revert: {
    args: [
      { name: "n", optional: true },
      { name: "files", optional: true, choices: ["files"] },
    ],
    help: "goes back to the end of turn n (default: drops the latest turn); files restores its files too",
    surfaces: ["chat", "gateway"],
    ownerOnly: true,
    dispatches: ["thread.revert"],
    whileBusy: { refuse: "A turn is running in this thread. Interrupt it or let it finish, then revert." },
  },
  "undo-revert": {
    args: [],
    help: "undoes the latest revert, until the next turn starts",
    surfaces: ["chat", "web", "gateway"],
    ownerOnly: true,
    dispatches: ["thread.revert.undo"],
    whileBusy: { refuse: "A turn has started since the latest revert, so there's no revert to undo." },
  },
  smart: {
    args: [{ name: "on|off", choices: ["on", "off"] }],
    help: "turns smart approvals of native terminal commands off, or back on, where approvals.yaml enables them",
    surfaces: ["chat"],
    ownerOnly: true,
    dispatches: ["approvals.smart.set"],
    whileBusy: "run",
  },
  trusted: {
    args: [],
    help: "lists the project commands you let Verdandi run",
    surfaces: ["chat"],
    ownerOnly: true,
    dispatches: [],
    whileBusy: "run",
  },
  untrust: {
    args: [{ name: "n" }],
    help: "revokes the nth list /trusted shows",
    surfaces: ["chat"],
    ownerOnly: true,
    dispatches: ["commands.trust.revoke"],
    whileBusy: "run",
  },
  skills: {
    args: [
      {
        name: "action",
        optional: true,
        choices: ["list", "history", "revert", "pin", "unpin", "restore", "install", "update", "uninstall"],
      },
      { name: "skill", optional: true },
      { name: "n", optional: true },
    ],
    help: "lists your skills; history, revert, pin, unpin and restore manage one; install, update and uninstall hub skills",
    surfaces: ["chat"],
    ownerOnly: true,
    dispatches: ["skill.revert", "skill.pin", "skill.unpin", "skill.restore", "skill.uninstall"],
    whileBusy: "run",
  },
  exit: {
    args: [],
    help: "quits",
    surfaces: ["chat"],
    ownerOnly: false,
    dispatches: [],
    whileBusy: "run",
  },
} as const satisfies Record<string, SlashEntry>;

/** `/rate`'s words; `clear` takes the rating back. */
export const ratingWords = new Map<string, TaskRating | null>([
  ["up", 1],
  ["down", -1],
  ["clear", null],
]);

export type SlashName = keyof typeof slashCommands;
/** The commands a surface offers. */
export type SlashNameOn<S extends Surface> = {
  [K in SlashName]: S extends (typeof slashCommands)[K]["surfaces"][number] ? K : never;
}[SlashName];

/** A command's entry, read as a `SlashEntry`. */
export const slashEntry = (name: SlashName): SlashEntry => slashCommands[name];

const names = Object.keys(slashCommands) as SlashName[];
export const slashNamesOn = <S extends Surface>(surface: S) =>
  names.filter((n): n is SlashNameOn<S> => slashEntry(n).surfaces.includes(surface));

/** `/name <arg> [optional]`, e.g. `/revert [n] [files]`. */
export const slashUsage = (name: SlashName) =>
  [
    `/${name}`,
    ...slashEntry(name).args.map((a) => {
      const shown = a.choices && a.choices.length > 1 ? a.choices.join("|") : (a.choices?.[0] ?? a.name);
      return a.optional ? `[${shown}]` : `<${shown}>`;
    }),
  ].join(" ");

/** The surface's commands, one per line: usage, then help. */
export const slashHelp = (surface: Surface) => {
  const shown = slashNamesOn(surface);
  const width = Math.max(...shown.map((n) => slashUsage(n).length));
  return shown.map((n) => `  ${slashUsage(n).padEnd(width)}  ${slashEntry(n).help}`).join("\n");
};

/** A line that names one of the surface's commands: its name and its words after it. Undefined for anything else. */
export const parseSlash = <S extends Surface>(line: string, surface: S) => {
  const [first = "", ...args] = line.trim().split(/\s+/);
  const name = first.slice(1);
  if (!first.startsWith("/") || !Object.hasOwn(slashCommands, name)) return undefined;
  const on = slashNamesOn(surface) as readonly string[];
  return on.includes(name) ? { name: name as SlashNameOn<S>, args } : undefined;
};

/**
 * What a draft can complete to on a surface: while its first word is `/name` being typed, the commands it starts;
 * after `/name `, the choices of the argument being typed. Each option is the whole line it completes to.
 */
export const slashCompletions = (text: string, surface: Surface) => {
  const m = /^\/(\S*)(?:\s+(.*))?$/.exec(text);
  if (!m) return [];
  const [, typed = "", rest] = m;
  if (rest === undefined) {
    return slashNamesOn(surface)
      .filter((n) => n.startsWith(typed))
      .map((n) => ({ line: `/${n}${slashEntry(n).args.length ? " " : ""}`, name: n, usage: slashUsage(n) }));
  }
  const name = slashNamesOn(surface).find((n) => n === typed);
  if (!name) return [];
  const words = rest.split(/\s+/);
  const word = words.at(-1) ?? "";
  const done = words.slice(0, -1);
  const choices = slashEntry(name).args[done.length]?.choices ?? [];
  return choices
    .filter((c) => c.startsWith(word))
    .map((c) => ({ line: [`/${name}`, ...done, c].join(" "), name, usage: slashUsage(name) }));
};

/** The longest start every option shares, so Tab completes as far as it's unambiguous. */
export const commonStart = (lines: readonly string[]) =>
  lines.reduce((a, b) => {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return a.slice(0, i);
  }, lines[0] ?? "");
