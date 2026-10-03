import { createCliRenderer, type InputRenderable } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import type { InteractionMode } from "@verdandi/contracts";
import { type ReactNode, useRef, useSyncExternalStore } from "react";
import { type Io, openSession, type Session, type SessionSetup } from "../cli/chat-session.ts";

// ponytail: the transcript keeps its last `keep` lines, since every line is a renderable; upgrade to rendering only
// the visible window if long threads need their whole history on screen.
const keep = 2000;

/** `lines` with `text` written after them: it continues the last line until a newline starts the next. */
export const appendText = (lines: readonly string[], text: string): string[] => {
  const [first = "", ...rest] = text.replaceAll("\r\n", "\n").split("\n");
  return [...lines.slice(0, -1), (lines.at(-1) ?? "") + first, ...rest];
};

/**
 * The transcript as an external store: the session writes to it as events and text deltas arrive, and React reads it
 * at most once per ~16 ms frame, so a burst of deltas renders once. It keeps the last `keep` lines and counts the ones
 * it trimmed, so each line keeps its number, and its React key, for life.
 */
export const createTranscript = () => {
  let view: { readonly lines: readonly string[]; readonly dropped: number } = { lines: [""], dropped: 0 };
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const notify = () => {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = undefined;
      for (const listener of listeners) listener();
    }, 16);
  };
  return {
    write: (text: string) => {
      const lines = appendText(view.lines, text);
      const over = Math.max(0, lines.length - keep);
      view = { lines: over ? lines.slice(over) : lines, dropped: view.dropped + over };
      notify();
    },
    /** Re-renders without new text: the mode or a request changed. */
    touch: notify,
    get: () => view,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
};
export type Transcript = ReturnType<typeof createTranscript>;

// From the web UI's palette (styles.css, dark): muted stone for Verdandi's own notes, rune ochre for what you typed.
// Other text keeps the terminal's own colour, which suits a light or a dark terminal.
const muted = "#a6a39c";
const rune = "#d08a63";
const lineColour = (line: string) => (line.startsWith("[") ? muted : /^(ask|plan)?> /.test(line) ? rune : undefined);

const prefix = (mode: InteractionMode) => (mode === "build" ? "> " : `${mode}> `);

/** What a typed line will do now, for the line under the transcript. */
const hint = (state: ReturnType<Session["state"]>) => {
  const r = state.request;
  if (r?.type === "plan.requested") return "Answer the plan above: y builds it, n rejects it, e edits it in $EDITOR";
  if (r?.type === "user-input.requested") return "Answer the question above: a number or your own words; /skip declines";
  if (r) return "Answer the request above: y or n";
  const files = state.attached.length ? ` · attached: ${state.attached.join(", ")}` : "";
  return state.running
    ? `${state.mode} · working: Enter steers the agent, Ctrl+C stops the turn${files}`
    : `${state.mode} · Enter sends · /ask /plan /build switch modes · Ctrl+C or /exit quits${files}`;
};

/** The chat screen: the transcript, what a typed line will do, and the composer. */
export const Chat = ({ session, transcript, onQuit }: { session: Session; transcript: Transcript; onQuit: () => void }): ReactNode => {
  const { lines, dropped } = useSyncExternalStore(transcript.subscribe, transcript.get);
  const composer = useRef<InputRenderable>(null);
  const state = session.state();
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c" && session.interrupt()) onQuit();
  });
  const submit = async (value: string) => {
    if (composer.current) composer.current.value = "";
    // The line chat's terminal echoes what you type; here the transcript does, marked like its prompt.
    transcript.write(`${state.request ? "" : prefix(state.mode)}${value}\n`);
    if (await session.input(value)) onQuit();
    transcript.touch();
  };
  return (
    <box flexDirection="column" width="100%" height="100%">
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
        {lines.map((line, i) => {
          const colour = lineColour(line);
          return (
            <text
              // biome-ignore lint/suspicious/noArrayIndexKey: dropped + i is the line's number in the whole transcript, which never changes.
              key={dropped + i}
              wrapMode="word"
              {...(colour === undefined ? {} : { fg: colour })}
            >
              {line || " "}
            </text>
          );
        })}
      </scrollbox>
      <text fg={muted} paddingLeft={1}>
        {hint(state)}
      </text>
      <box border height={3}>
        <input
          ref={composer}
          focused
          // The input keeps its own text and hands it over on Enter, so fast typing never races a React render.
          onSubmit={(value) => void submit(typeof value === "string" ? value : (composer.current?.value ?? ""))}
          placeholder={state.request ? "Your answer" : "Message the agent"}
        />
      </box>
    </box>
  );
};

/**
 * The terminal UI on OpenTUI (ADR 0027): what bare `verdandi` opens in a terminal. It drives the same session as the
 * line chat (`openSession`), so commands, requests and event lines are identical; it only draws them.
 */
export const terminalUi = async (setup: SessionSetup, notes: readonly string[], done: () => Promise<void>) => {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const transcript = createTranscript();
  const io: Io = {
    write: transcript.write,
    prompt: () => transcript.touch(),
    // The user's $EDITOR gets the terminal while it runs, then the UI takes it back.
    suspend: async (run) => {
      renderer.suspend();
      try {
        return await run();
      } finally {
        renderer.resume();
      }
    },
  };
  const session = await openSession(setup, io, notes);
  let quitting = false;
  const quit = () => {
    if (quitting) return;
    quitting = true;
    renderer.destroy();
    void session
      .close()
      .then(done)
      .finally(() => process.exit(0));
  };
  createRoot(renderer).render(<Chat session={session} transcript={transcript} onQuit={quit} />);
};
