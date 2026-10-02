import { type TerminalId, TerminalUnavailable, type TerminalView, type ThreadId } from "@verdandi/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Connection } from "../client.ts";
import { CloseIcon, PlusIcon } from "../ui/icons.tsx";

/** What an ended terminal says, in it and in the status line. */
const endText = (t: TerminalView) =>
  t.status === "lost"
    ? "This terminal was lost: verdandid's PTY host stopped. Close it and open a new one."
    : `The shell exited${t.exitCode === null ? "" : ` with code ${t.exitCode}`}.`;

/**
 * The right panel's Terminal tab: the thread's terminals, which keep running while the page is closed or
 * reloaded, and show their recent output again when it comes back. With none open, the tab starts one.
 */
export const TerminalTab = ({ connection, threadId }: { connection: Connection; threadId: ThreadId }) => {
  const [terminals, setTerminals] = useState<readonly TerminalView[]>();
  const [current, setCurrent] = useState<TerminalId>();
  const [error, setError] = useState<string>();
  const toolbar = useRef<HTMLDivElement>(null);
  const hintId = useId();

  const open = useCallback(async () => {
    // The screen fits the shell to the panel as soon as it's shown.
    const result = await connection.terminals.open(threadId, 80, 24);
    setError(result.ok ? undefined : result.message);
    if (!result.ok) return;
    setTerminals((ts) => [...(ts ?? []), result.value]);
    setCurrent(result.value.terminalId);
  }, [connection, threadId]);

  useEffect(() => {
    let mounted = true;
    void connection.terminals.list(threadId).then((result) => {
      if (!mounted) return;
      if (!result.ok) return setError(result.message);
      setTerminals(result.value);
      setCurrent(result.value.at(-1)?.terminalId);
      if (result.value.length === 0) void open();
    });
    return () => {
      mounted = false;
    };
  }, [connection, threadId, open]);

  const close = async (terminalId: TerminalId) => {
    const result = await connection.terminals.close(terminalId);
    setError(result.ok ? undefined : result.message);
    const rest = (terminals ?? []).filter((t) => t.terminalId !== terminalId);
    setTerminals(rest);
    setCurrent(rest.at(-1)?.terminalId);
    toolbar.current?.querySelector("button")?.focus();
  };
  const ended = useCallback(
    (view: TerminalView) => setTerminals((ts) => ts?.map((t) => (t.terminalId === view.terminalId ? view : t))),
    [],
  );
  const leave = useCallback(() => toolbar.current?.querySelector("button")?.focus(), []);

  const shown = terminals?.find((t) => t.terminalId === current);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={toolbar} className="flex flex-wrap items-center gap-1.5 px-3 pt-2">
        {terminals?.map((t, i) => (
          <button
            key={t.terminalId}
            type="button"
            className="px-2 text-xs aria-pressed:border-accent aria-pressed:text-accent"
            aria-pressed={t.terminalId === current}
            onClick={() => setCurrent(t.terminalId)}
          >
            Terminal {i + 1}
            {t.status !== "running" && <span className="text-muted">({t.status})</span>}
          </button>
        ))}
        <button type="button" className="px-2 text-xs" onClick={() => void open()}>
          <PlusIcon className="size-3.5" />
          New terminal
        </button>
        {shown && (
          <button type="button" className="ml-auto px-2 text-xs" onClick={() => void close(shown.terminalId)}>
            <CloseIcon className="size-3.5" />
            Close terminal
          </button>
        )}
      </div>
      <p id={hintId} className="mx-3 mt-1 text-xs text-muted">
        Keys, Tab and Escape included, go to the shell. Press F6 to move focus out of the terminal.
      </p>
      <p role="status" className={`mx-3 my-1 text-xs ${error || shown?.status === "lost" ? "text-error" : "text-muted"}`}>
        {error ?? (terminals === undefined ? "Loading…" : shown && shown.status !== "running" ? endText(shown) : "")}
      </p>
      {shown && <Screen key={shown.terminalId} connection={connection} terminal={shown} hintId={hintId} onEnded={ended} onLeave={leave} />}
    </div>
  );
};

/**
 * One terminal, drawn by xterm.js. It replays the output verdandid kept, then follows live output; keys go to
 * the shell, and the shell is resized to fit the panel. The cursor doesn't blink: nothing repaints on its own.
 */
const Screen = ({
  connection,
  terminal,
  hintId,
  onEnded,
  onLeave,
}: {
  connection: Connection;
  terminal: TerminalView;
  hintId: string;
  onEnded: (view: TerminalView) => void;
  onLeave: () => void;
}) => {
  const element = useRef<HTMLElement>(null);
  const { terminalId } = terminal;
  useEffect(() => {
    const el = element.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const term = new Terminal({
      cursorBlink: false,
      screenReaderMode: true,
      fontFamily: style.fontFamily,
      fontSize: 13,
      scrollback: 5000,
      theme: { background: style.backgroundColor, foreground: style.color, cursor: style.color },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.attachCustomKeyEventHandler((e) => {
      if (e.key !== "F6") return true;
      if (e.type === "keydown") {
        e.preventDefault();
        onLeave();
      }
      return false;
    });
    term.onData((data) => void connection.terminals.write(terminalId, data));
    term.onResize(({ cols, rows }) => void connection.terminals.resize(terminalId, cols, rows));
    // Fitted on the next frame: resizing the screen inside the observer's callback would re-trigger it in the same frame.
    let frame = 0;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fit.fit());
    });
    let disposed = false;
    // Cells are measured when the terminal opens, so the font must be ready by then.
    void document.fonts.load(`13px ${style.fontFamily}`).then(() => {
      if (disposed) return;
      term.open(el);
      term.textarea?.setAttribute("aria-describedby", hintId);
      resize.observe(el);
      term.focus();
    });
    const end = (view: TerminalView) => {
      term.write(`\r\n\x1b[2m${endText(view)}\x1b[0m\r\n`);
      onEnded(view);
    };
    const stop = connection.follow(
      (rpc, subscriptionId) => rpc.TerminalSubscribe({ terminalId, subscriptionId }),
      (feed) => {
        if (feed.kind === "output") return term.write(feed.data);
        if (feed.kind === "ended") return end(feed.terminal);
        term.write(feed.output);
        if (feed.terminal.status !== "running") end(feed.terminal);
      },
      (message) => term.write(`\r\n${message}\r\n`),
      TerminalUnavailable,
    );
    return () => {
      disposed = true;
      stop();
      resize.disconnect();
      cancelAnimationFrame(frame);
      term.dispose();
    };
  }, [connection, terminalId, hintId, onEnded, onLeave]);
  return (
    <div className="min-h-0 flex-1 bg-card p-2">
      <section ref={element} aria-label="Terminal" className="h-full bg-card font-mono text-fg" />
    </div>
  );
};
