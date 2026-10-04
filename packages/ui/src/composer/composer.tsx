import {
  atPin,
  type BudgetMode,
  type ClientCommand,
  type CommandId,
  type InteractionMode,
  parseSlash,
  type Question,
  type Resolution,
  type RouteTarget,
  ratingWords,
  type SkillChange,
  type SlashNameOn,
  slashCompletions,
  slashEntry,
  type ThreadId,
  type ThreadView,
  type TurnId,
  trustFiles,
} from "@verdandi/contracts";
import { type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { SmartApprovals } from "../approvals/smart-approvals.tsx";
import { type Connection, type Routed, uuid } from "../client.ts";
import { TextDiff } from "../diffs/diff.tsx";
import { RouteChip } from "../routing/route.tsx";
import { SpendCaps } from "../spend/spend.tsx";
import type { LiveThread } from "../state.ts";
import { PaperclipIcon, SendIcon, StopIcon } from "../ui/icons.tsx";
import { Rune, type RuneName } from "../ui/runes.tsx";
import { addFiles, type Pending, PendingList } from "./attachments.tsx";

/** Each mode with its rune: ansuz, the word, to ask; raidho, the road, to plan; uruz, strength, to build. */
const modes: { value: InteractionMode; label: string; hint: string; rune: RuneName }[] = [
  { value: "ask", label: "Ask", hint: "answers without changing anything", rune: "ansuz" },
  { value: "plan", label: "Plan", hint: "proposes a plan for you to approve first", rune: "raidho" },
  { value: "build", label: "Build", hint: "does the work", rune: "uruz" },
];

/**
 * Sends the next turn in the chosen mode. While a turn runs, a message steers it instead: the agent
 * reads it at its next step (ADR 0003). Enter sends, Shift+Enter starts a new line. Images and files
 * pasted, dropped or picked go with the next turn; a steer can't carry them.
 */
export const Composer = ({
  connection,
  thread,
  mode,
  onMode,
}: {
  connection: Connection;
  thread: LiveThread;
  mode: InteractionMode;
  onMode: (mode: InteractionMode) => void;
}) => {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState<readonly Pending[]>([]);
  /** Sends a spend cap rejected, so the caps shown catch up with spend in other threads. */
  const [capRejections, setCapRejections] = useState(0);
  const running = thread.turns.findLast((t) => t.status === "running");
  const { threadId } = thread;
  const menu = useComposerMenu(connection, text, running !== undefined, setText);
  /** What a command run from the message box did, when its effect doesn't show elsewhere. */
  const [notice, setNotice] = useState<string>();

  const attach = async (files: readonly File[]) => {
    if (files.length === 0) return;
    if (running) return setError("Attachments go with a new turn: send them once this one finishes.");
    const { added, error } = await addFiles(files, pending);
    setError(error);
    setPending((p) => [...p, ...added]);
  };
  const detach = (key: string) =>
    setPending((p) => {
      const gone = p.find((x) => x.key === key);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return p.filter((x) => x !== gone);
    });
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0) return;
    e.preventDefault();
    void attach(files);
  };
  const onDrop = (e: DragEvent) => {
    if (e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    void attach(Array.from(e.dataTransfer.files));
  };
  const fail = (message: string, body: string) => {
    setError(message);
    setText((current) => current || body);
  };
  /** Runs a web command of `slashCommands` and says how it went; each one gets a handler, or this fails typecheck. */
  const run = async (command: ClientCommand, done: string) => {
    const result = await connection.dispatch(command);
    if (result.ok) setNotice(done);
    else setError(result.message);
  };
  const commands: Record<SlashNameOn<"web">, (args: readonly string[]) => unknown> = {
    ask: () => onMode("ask"),
    plan: () => onMode("plan"),
    build: () => onMode("build"),
    rate: (args) => {
      const rating = ratingWords.get(args[0] ?? "");
      const task = thread.tasks.at(-1);
      if (rating === undefined) return setError("Rate the latest task with /rate up, /rate down or /rate clear.");
      if (!task) return setError("This thread has no task to rate yet.");
      return run(
        { type: "task.rate", commandId: uuid<CommandId>(), threadId, taskId: task.taskId, rating },
        rating === null ? "Rating cleared." : `Rated the latest task ${args[0]}.`,
      );
    },
    "forget-routing": () =>
      run(
        { type: "routing.memory.clear", commandId: uuid<CommandId>(), threadId },
        "Routing memory cleared: this project's next routed tasks go by the policy alone.",
      ),
    "undo-revert": () => run({ type: "thread.revert.undo", commandId: uuid<CommandId>(), threadId }, "Revert undone."),
  };
  const send = async () => {
    const body = text.trim();
    if (!body && (running || pending.length === 0)) return;
    setError(undefined);
    setNotice(undefined);
    // A web command runs here and never reaches the agent; one the registry refuses while a turn runs says when it works.
    const command = parseSlash(body, "web");
    if (command) {
      const busy = slashEntry(command.name).whileBusy;
      if (running && typeof busy === "object") return setError(busy.refuse);
      setText("");
      return void (await commands[command.name](command.args));
    }
    setText("");
    if (running) {
      const steered = await connection.dispatch({
        type: "turn.steer",
        commandId: uuid<CommandId>(),
        threadId,
        turnId: running.turnId,
        text: body,
      });
      // A turn that finished meanwhile gets the message as the next turn instead.
      if (steered.ok || steered.reason !== "TurnNotRunning") {
        if (!steered.ok) fail(steered.message, body);
        return;
      }
    }
    const sent = await connection.dispatch({
      type: "turn.send",
      commandId: uuid<CommandId>(),
      threadId,
      turnId: uuid<TurnId>(),
      text: body,
      mode,
      ...(pending.length > 0 && { attachments: pending.map(({ name, mediaType, data }) => ({ name, mediaType, data })) }),
    });
    if (!sent.ok) fail(sent.message, body);
    else {
      for (const p of pending) if (p.preview) URL.revokeObjectURL(p.preview);
      setPending([]);
    }
    if (!sent.ok && sent.reason === "SpendCapReached") setCapRejections((n) => n + 1);
  };
  const stop = async () => {
    if (!running) return;
    const stopped = await connection.dispatch({ type: "turn.interrupt", commandId: uuid<CommandId>(), threadId, turnId: running.turnId });
    if (!stopped.ok) setError(stopped.message);
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu.onKeyDown(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const hint = modes.find((m) => m.value === mode)?.hint;
  const command = parseSlash(text, "web");
  // Only a message that starts a routed task gets a preview: one that continues a task keeps its route. A leading `@name` starts one.
  const preview = !running && ((!thread.pinned && thread.task === null) || atPin(text) !== undefined);
  return (
    <div className="mx-auto w-full max-w-[860px] px-3 pt-2 pb-3 sm:px-4">
      <div className="mb-1.5 flex flex-col gap-1">
        <SpendCaps connection={connection} thread={thread} rejected={capRejections} />
        <SmartApprovals connection={connection} />
        <RouteChip connection={connection} thread={thread} />
      </div>
      <form
        onSubmit={onSubmit}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="relative rounded-lg border border-line-strong bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04)] focus-within:border-accent focus-within:shadow-[0_0_0_1px_var(--color-accent)]"
      >
        {menu.menu}
        <PendingList items={pending} onRemove={detach} />
        <label className="sr-only" htmlFor="message">
          {running ? "Steer the running turn" : "Message"}
        </label>
        {/* The form's border shows focus, so the field itself needs no ring. */}
        <textarea
          id="message"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="block max-h-[40vh] w-full resize-y rounded-lg border-0 bg-transparent px-3.5 pt-3 outline-none focus-visible:outline-none"
          placeholder={running ? "Steer the agent: it reads this at its next step" : "Message the agent, or @model to pin its task"}
          aria-describedby={preview ? "route-preview" : undefined}
          {...menu.inputProps}
        />
        {preview && (
          <RoutePreview
            connection={connection}
            thread={thread}
            text={menu.open || command ? "" : text}
            idle={
              menu.pins
                ? "Pins the task this message starts to the model you pick."
                : menu.open || command
                  ? "Runs the command here: nothing goes to the agent."
                  : undefined
            }
            mode={mode}
            images={pending.filter((p) => p.preview !== undefined).length}
          />
        )}
        <div className="flex flex-wrap items-center gap-2 px-2 pt-1 pb-2">
          {!running && (
            <label
              className="inline-flex min-h-7 items-center rounded-md px-2 text-muted hover:bg-hover hover:text-fg has-focus-visible:outline-2 has-focus-visible:outline-accent pointer-coarse:min-h-11"
              title="Attach images or files, or paste or drop them here"
            >
              <PaperclipIcon />
              <span className="sr-only">Attach files</span>
              <input
                type="file"
                multiple
                className="sr-only"
                onChange={(e) => {
                  void attach(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
            </label>
          )}
          <fieldset className="flex rounded-lg border border-line bg-bg p-0.5" aria-describedby="mode-hint">
            <legend className="sr-only">Mode for the next turn</legend>
            {modes.map((m) => (
              <label
                key={m.value}
                className="inline-flex min-h-6 items-center rounded-md px-2.5 text-xs font-medium text-muted hover:text-fg has-checked:bg-card has-checked:text-fg has-checked:shadow-[inset_0_0_0_1px_var(--color-line-strong)] has-focus-visible:outline-2 has-focus-visible:outline-accent pointer-coarse:min-h-10"
              >
                <input
                  type="radio"
                  name="mode"
                  value={m.value}
                  checked={mode === m.value}
                  onChange={() => onMode(m.value)}
                  className="sr-only"
                />
                <Rune name={m.rune} className="mr-1 size-3 text-rune" />
                {m.label}
              </label>
            ))}
          </fieldset>
          <span id="mode-hint" className="hidden text-xs text-muted sm:inline">
            {hint}
            {running ? "; applies from the next turn" : ""}
          </span>
          <span className="ml-auto flex items-center gap-2">
            <BudgetSwitch connection={connection} thread={thread} running={running !== undefined} onError={setError} />
            {running && (
              <button type="button" onClick={stop}>
                <StopIcon className="size-3.5" />
                Stop
              </button>
            )}
            <button type="submit" disabled={!text.trim() && (running !== undefined || pending.length === 0)}>
              <SendIcon className="size-3.5" />
              {running ? "Steer" : "Send"}
            </button>
          </span>
        </div>
      </form>
      {error && (
        <p role="alert" className="mt-1.5 px-1 text-xs text-error">
          {error}
        </p>
      )}
      <p role="status" className="mt-1.5 px-1 text-xs text-muted empty:hidden">
        {notice}
      </p>
    </div>
  );
};

const budgets: { value: BudgetMode | null; label: string }[] = [
  { value: null, label: "Policy" },
  { value: "thrifty", label: "Thrifty" },
  { value: "balanced", label: "Balanced" },
  { value: "max", label: "Max" },
];

/**
 * How the router trades cost against strength for this thread (DESIGN §8.3). A change starts a new task
 * with the next turn, routed under the new mode; a pinned thread's route doesn't move until it's unpinned.
 */
const BudgetSwitch = ({
  connection,
  thread,
  running,
  onError,
}: {
  connection: Connection;
  thread: LiveThread;
  running: boolean;
  onError: (message: string) => void;
}) => {
  const [sending, setSending] = useState(false);
  const id = useId();
  const set = async (mode: BudgetMode | null) => {
    setSending(true);
    const result = await connection.dispatch({ type: "thread.budget.set", commandId: uuid<CommandId>(), threadId: thread.threadId, mode });
    setSending(false);
    if (!result.ok) onError(result.message);
  };
  const note = thread.pinned
    ? "Pinned: the router doesn't pick, so the budget mode waits until you let it."
    : running
      ? "Applies from the next turn, which starts a new task."
      : "Policy uses the routing policy's mode.";
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted" title={note}>
      Budget{" "}
      <select
        className="text-xs text-fg"
        value={thread.budgetMode ?? ""}
        disabled={thread.pinned || sending}
        aria-describedby={`${id}-note`}
        onChange={(e) => void set(budgets.find((b) => (b.value ?? "") === e.target.value)?.value ?? null)}
      >
        {budgets.map((b) => (
          <option key={b.label} value={b.value ?? ""}>
            {b.label}
          </option>
        ))}
      </select>
      <span id={`${id}-note`} className="sr-only">
        {note}
      </span>
    </label>
  );
};

/**
 * What the router would pick if this draft were sent now (DESIGN §12), asked once typing pauses. A
 * slower answer for an older draft never replaces a newer one.
 */
const RoutePreview = ({
  connection,
  thread,
  text,
  idle = "The router picks a route when you send.",
  mode,
  images,
}: {
  connection: Connection;
  thread: LiveThread;
  text: string;
  /** Shown with no draft to route. */
  idle?: string | undefined;
  mode: InteractionMode;
  images: number;
}) => {
  const [routed, setRouted] = useState<Routed>();
  const draft = text.trim();
  const { threadId, budgetMode } = thread;
  // biome-ignore lint/correctness/useExhaustiveDependencies: verdandid reads the budget mode from the thread, so a new one asks again.
  useEffect(() => {
    if (!draft) return setRouted(undefined);
    let current = true;
    const timer = setTimeout(() => void connection.simulate(threadId, draft, mode, images).then((r) => current && setRouted(r)), 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [connection, threadId, draft, mode, images, budgetMode]);
  const decision = routed?.ok ? routed.decision : undefined;
  return (
    <p id="route-preview" className="px-3 text-xs text-muted" aria-live="polite">
      {!draft || !routed
        ? idle
        : decision
          ? `Routes to ${decision.target.model} · ${decision.effort} on ${decision.target.harness}: ${decision.reason}`
          : !routed.ok && <span className="text-error">{routed.message}</span>}
    </p>
  );
};

/** One line the composer's menu offers: picking it puts `line` in the message box. */
type MenuOption = { readonly key: string; readonly label: string; readonly detail: string; readonly line: string };

/**
 * The composer's menu, offered while the message is a `@name` being typed (the models a message can pin its task to,
 * DESIGN §12; not while steering) or a `/command` (the registry's web commands, or the choices of the argument being
 * typed). An ARIA listbox the message box drives with `aria-activedescendant`, so focus stays in the box. Arrow keys
 * move, Enter or Tab picks, Escape closes; Enter on an option the message already says falls through, so it runs.
 * Not Base UI's Autocomplete: that treats the whole field as its query, and its Escape clears the field and its Home
 * and End jump to the field's ends, wrong for a multi-line message.
 */
const useComposerMenu = (connection: Connection, text: string, steering: boolean, setText: (text: string) => void) => {
  const [models, setModels] = useState<readonly RouteTarget[]>([]);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string>();
  const id = useId();
  useEffect(() => {
    void connection.models().then(setModels);
  }, [connection]);
  const typed = steering ? undefined : /^@(\S*)$/.exec(text)?.[1]?.toLowerCase();
  const pins = text.startsWith("@");
  const options: MenuOption[] =
    text === dismissed
      ? []
      : pins
        ? typed === undefined
          ? []
          : models
              .filter((m) => m.model.toLowerCase().startsWith(typed))
              // The exact name first, so Enter on a typed name picks it.
              .toSorted((a, b) => Number(b.model.toLowerCase() === typed) - Number(a.model.toLowerCase() === typed))
              .map((m) => ({ key: `${m.harness} ${m.model}`, label: `@${m.model}`, detail: m.harness, line: `@${m.model} ` }))
        : slashCompletions(text, "web").map((o) => ({ key: o.line, label: o.line.trim(), detail: slashEntry(o.name).help, line: o.line }));
  const open = options.length > 0;
  const current = Math.min(active, options.length - 1);
  const pick = (o: MenuOption) => {
    setText(o.line);
    setActive(0);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || e.nativeEvent.isComposing) return false;
    const chosen = options[current];
    if (e.key === "ArrowDown" || e.key === "ArrowUp")
      setActive((current + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
      if (!chosen || (e.key === "Enter" && chosen.line === text)) return false;
      pick(chosen);
    } else if (e.key === "Escape") setDismissed(text);
    else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };
  const option = (i: number) => `${id}-option-${i}`;
  const what = pins ? `model${options.length === 1 ? "" : "s"} to pin this task to` : `command${options.length === 1 ? "" : "s"}`;
  const menu = (
    <>
      <p role="status" className="sr-only">
        {open ? `${options.length} ${what}: arrow keys choose, Enter picks.` : ""}
      </p>
      {open && (
        <div
          id={`${id}-options`}
          role="listbox"
          aria-label={pins ? "Pin this task to a model" : "Commands"}
          className="absolute bottom-full left-0 z-10 mb-1 min-w-56 rounded-lg border border-line-strong bg-card p-1 text-sm shadow-lg"
        >
          {options.map((o, i) => (
            // Picked by pointer here; by keyboard from the message box, which keeps focus.
            // biome-ignore lint/a11y/useKeyWithClickEvents: the message box handles the keys for its listbox (aria-activedescendant).
            <div
              key={o.key}
              id={option(i)}
              role="option"
              tabIndex={-1}
              aria-selected={i === current}
              className="flex cursor-pointer items-center justify-between gap-6 rounded-md px-2 py-1 hover:bg-hover aria-selected:bg-hover"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
            >
              <span className="font-mono">{o.label}</span>
              <span className="text-xs text-muted">{o.detail}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
  const inputProps = {
    "aria-autocomplete": "list",
    "aria-controls": open ? `${id}-options` : undefined,
    "aria-activedescendant": open ? option(current) : undefined,
    onInput: () => setActive(0),
  } as const;
  return { open, pins: open && pins, menu, onKeyDown, inputProps };
};

type Request = ThreadView["pendingRequests"][number];

/** Requests the agent is waiting on, oldest first. */
export const Requests = ({
  connection,
  threadId,
  requests,
  onPlanApproved,
}: {
  connection: Connection;
  threadId: ThreadId;
  requests: ThreadView["pendingRequests"];
  onPlanApproved: () => void;
}) =>
  requests.length === 0 ? null : (
    <section className="max-h-[45vh] shrink-0 overflow-y-auto border-t border-line py-2" aria-label="Waiting for your answer">
      {requests.map((r) => (
        <RequestCard key={r.requestId} connection={connection} threadId={threadId} request={r} onPlanApproved={onPlanApproved} />
      ))}
    </section>
  );

const RequestCard = ({
  connection,
  threadId,
  request,
  onPlanApproved,
}: {
  connection: Connection;
  threadId: ThreadId;
  request: Request;
  onPlanApproved: () => void;
}) => {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const respond = async (resolution: Resolution) => {
    setSending(true);
    const result = await connection.dispatch({
      type: "approval.respond",
      commandId: uuid<CommandId>(),
      threadId,
      requestId: request.requestId,
      resolution,
    });
    setSending(false);
    if (!result.ok) setError(result.message);
    // An approved plan goes on in build mode, and so do the turns after it.
    else if (request.type === "plan.requested" && resolution.decision === "allow") onPlanApproved();
  };
  return (
    <div className="mx-auto max-w-[860px] px-3 py-1 sm:px-4">
      <div className="border border-line border-l-2 border-l-warn bg-card px-4 py-3">
        <p className="eyebrow mb-1 flex items-center gap-1.5 text-warn">
          <span aria-hidden className="size-1.5 rounded-full bg-warn" />
          Waiting for you
        </p>
        {request.type === "approval.requested" && <Approval request={request} sending={sending} respond={respond} />}
        {request.type === "user-input.requested" && <Questions request={request} sending={sending} respond={respond} />}
        {request.type === "plan.requested" && <PlanApproval request={request} sending={sending} respond={respond} />}
        {request.type === "skill.proposed" && <SkillApproval request={request} sending={sending} respond={respond} />}
        {request.type === "memory.proposed" && <MemoryApproval request={request} sending={sending} respond={respond} />}
        {request.type === "commands.trust.requested" && <TrustApproval request={request} sending={sending} respond={respond} />}
        {request.type === "skill.install.proposed" && (
          <InstallApproval request={request} sending={sending} respond={respond} connection={connection} />
        )}
        {error && (
          <p role="alert" className="mt-2 text-error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
};

type CardProps<T extends Request["type"]> = {
  request: Extract<Request, { type: T }>;
  sending: boolean;
  respond: (resolution: Resolution) => Promise<void>;
};

const Approval = ({ request, sending, respond }: CardProps<"approval.requested">) => (
  <>
    <h3 className="font-serif text-lg font-semibold">
      Allow <span className="font-mono">{request.toolName}</span>?
    </h3>
    <pre>{JSON.stringify(request.input, null, 2)}</pre>
    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
      <button type="button" disabled={sending} onClick={() => respond({ decision: "deny" })}>
        Deny
      </button>
      <button
        type="button"
        className="border-go bg-go text-on-go hover:bg-go-hover"
        disabled={sending}
        onClick={() => respond({ decision: "allow" })}
      >
        Allow
      </button>
    </div>
  </>
);

const skillTitles = {
  create: (c: SkillChange) => (
    <>
      Create the skill <span className="font-mono">{c.skill}</span>?
    </>
  ),
  patch: (c: SkillChange) => (
    <>
      Change <span className="font-mono">{`${c.skill}/${c.path}`}</span>?
    </>
  ),
  write_file: (c: SkillChange) => (
    <>
      Write <span className="font-mono">{`${c.skill}/${c.path}`}</span>?
    </>
  ),
  delete: (c: SkillChange) => (
    <>
      Delete the skill <span className="font-mono">{c.skill}</span>? Its folder moves to the archive.
    </>
  ),
} as const;

/** A skill change the agent proposes (DESIGN §14.4): its diff, allowed as shown or declined with a reason for the agent. */
const SkillApproval = ({ request, sending, respond }: CardProps<"skill.proposed">) => {
  const [feedback, setFeedback] = useState("");
  const id = useId();
  const { change } = request;
  return (
    <>
      <h3 className="font-serif text-lg font-semibold">{skillTitles[change.action](change)}</h3>
      <p className="text-xs text-muted">Into your profile's skills folder. Nothing is written unless you allow it.</p>
      <section aria-label="Proposed change" className="max-h-[30vh] overflow-y-auto border border-line bg-bg">
        <TextDiff before={change.before ?? ""} after={change.after ?? ""} />
      </section>
      <label htmlFor={id} className="mt-2 mb-1 block text-xs font-medium text-muted">
        Why you decline it, for the agent (optional)
      </label>
      <textarea id={id} rows={2} className="w-full" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          disabled={sending}
          onClick={() => respond(feedback.trim() ? { decision: "deny", feedback: feedback.trim() } : { decision: "deny" })}
        >
          Decline
        </button>
        <button
          type="button"
          className="border-go bg-go text-on-go hover:bg-go-hover"
          disabled={sending}
          onClick={() => respond({ decision: "allow" })}
        >
          Allow
        </button>
      </div>
    </>
  );
};

/** Whether a hub file is new, removed or changed, for its heading. */
const fileTag = (before: string | null, after: string | null) => (before === null ? " (new)" : after === null ? " (removed)" : "");

/**
 * A hub skill's install or update (DESIGN §14.4): every file's diff, scripts included, the scans' verdicts as advice,
 * and the files the user changed, which it keeps, each with upstream's change and a way to take it instead.
 */
const InstallApproval = ({ request, sending, respond, connection }: CardProps<"skill.install.proposed"> & { connection: Connection }) => {
  const [taking, setTaking] = useState<string>();
  const [error, setError] = useState<string>();
  const { skill, pin, from, changes, kept, taken, advice } = request;
  // Taking upstream's file is a new proposal from the same ref, with the files taken so far, which replaces this one.
  const take = async (path: string) => {
    setTaking(path);
    const result = await connection.installSkill({ skill, ref: pin.ref, take: [...taken, path] });
    setTaking(undefined);
    if (!result.ok) setError(result.message);
  };
  return (
    <>
      <h3 className="font-serif text-lg font-semibold">
        {from ? "Update" : "Install"} the hub skill <span className="font-mono">{skill}</span>?
      </h3>
      <p className="text-xs text-muted [overflow-wrap:anywhere]">
        From <span className="font-mono">{pin.source}</span> ({pin.path}), pinned to commit{" "}
        <span className="font-mono">{pin.sha.slice(0, 12)}</span>
        {pin.ref === pin.sha ? "" : ` (${pin.ref})`}
        {from ? `, from ${from.slice(0, 12)}` : ""}. Into your profile's skills folder; nothing is written unless you allow it.
      </p>
      <section aria-label="What the scans flagged" className="mt-2">
        {advice.length === 0 ? (
          <p className="text-xs text-muted">The scans flagged nothing, which proves nothing: read every file before you allow it.</p>
        ) : (
          <ul className="text-xs text-warn">
            {advice.map((a) => (
              <li key={a.path} className="[overflow-wrap:anywhere]">
                <span className="font-mono">{a.path}</span>: {a.why}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Files it writes" className="mt-2 max-h-[30vh] overflow-y-auto border border-line bg-bg">
        {changes.length === 0 && <p className="px-2 py-1 text-xs text-muted">No file changes: allowing it records the new commit.</p>}
        {changes.map((c) => (
          <div key={c.path}>
            <p className="border-b border-line px-2 pt-1 font-mono text-xs font-medium">
              {c.path}
              {fileTag(c.before, c.after)}
            </p>
            <TextDiff before={c.before ?? ""} after={c.after ?? ""} />
          </div>
        ))}
      </section>
      {kept.length > 0 && (
        <section aria-label="Files you changed, which it keeps" className="mt-2 max-h-[30vh] overflow-y-auto border border-line bg-bg">
          {kept.map((k) => (
            <div key={k.path}>
              <div className="flex items-center justify-between gap-2 border-b border-line px-2 pt-1">
                <p className="text-xs">
                  <span className="font-mono font-medium">{k.path}</span>: you changed it, so it stays as you left it. Upstream's change:
                </p>
                <button
                  type="button"
                  className="shrink-0 px-2 text-xs"
                  disabled={sending || taking !== undefined}
                  onClick={() => void take(k.path)}
                >
                  {taking === k.path ? "Fetching…" : "Take upstream's"}
                </button>
              </div>
              <TextDiff before={k.before ?? ""} after={k.after ?? ""} />
            </div>
          ))}
        </section>
      )}
      {error && (
        <p role="alert" className="mt-2 text-error [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button type="button" disabled={sending} onClick={() => respond({ decision: "deny" })}>
          Decline
        </button>
        <button
          type="button"
          className="border-go bg-go text-on-go hover:bg-go-hover"
          disabled={sending}
          onClick={() => respond({ decision: "allow" })}
        >
          {from ? "Update" : "Install"}
        </button>
      </div>
    </>
  );
};

/**
 * A fact proposed for memory: by a background review of this thread's task (DESIGN §14.5), or the agent's own save in a
 * turn that read untrusted input (§17). Kept only if allowed.
 */
const MemoryApproval = ({ request, sending, respond }: CardProps<"memory.proposed">) => (
  <>
    <h3 className="font-serif text-lg font-semibold">Remember this {request.scope === "user" ? "about you" : "about this project"}?</h3>
    <p className="text-xs text-muted">
      {request.untrusted
        ? `The agent saved it after reading untrusted input (${request.untrusted.source}, turn ${request.untrusted.turn}), which may have planted it.`
        : "A background review of this task proposes it."}{" "}
      Nothing is remembered unless you allow it; you can edit it later in Memory.
    </p>
    <blockquote className="mt-2 border-l-2 border-line pl-3 whitespace-pre-wrap">{request.text}</blockquote>
    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
      <button type="button" disabled={sending} onClick={() => respond({ decision: "deny" })}>
        Decline
      </button>
      <button
        type="button"
        className="border-go bg-go text-on-go hover:bg-go-hover"
        disabled={sending}
        onClick={() => respond({ decision: "allow" })}
      >
        Remember
      </button>
    </div>
  </>
);

/**
 * The project's own commands, which Verdandi runs only once trusted, or context files the injection scan flagged, which
 * the harness loads only once trusted: allowing trusts this exact list in the project.
 */
const TrustApproval = ({ request, sending, respond }: CardProps<"commands.trust.requested">) => {
  const context = request.purpose === "context";
  return (
    <>
      <h3 className="font-serif text-lg font-semibold">
        {context
          ? "Start the agent with these flagged files?"
          : request.purpose === "mcp"
            ? "Start this project's MCP servers?"
            : `Run this project's ${request.purpose === "verifiers" ? "verifiers" : "worktree setup"}?`}
      </h3>
      {context ? (
        <p className="text-xs text-muted">
          The injection scan flagged these files, which the agent's harness loads by itself and can't leave out; the turn shows why.
          Allowing trusts these files as they are now in the project until you revoke it on the projects page; if one changes, Verdandi asks
          again. Not starting ends the turn.
        </p>
      ) : (
        <p className="text-xs text-muted">
          From <span className="font-mono">{trustFiles[request.purpose]}</span> in the project. Allowing trusts this exact list there until
          you revoke it on the projects page; if the file changes, Verdandi asks again.
        </p>
      )}
      <pre>{request.commands.join("\n")}</pre>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button type="button" disabled={sending} onClick={() => respond({ decision: "deny" })}>
          {context ? "Don't start" : "Don't run"}
        </button>
        <button
          type="button"
          className="border-go bg-go text-on-go hover:bg-go-hover"
          disabled={sending}
          onClick={() => respond({ decision: "allow" })}
        >
          {context ? "Trust and start" : "Trust and run"}
        </button>
      </div>
    </>
  );
};

/** Approve the plan, edit it first (the agent builds from the edit), or keep planning with feedback. */
const PlanApproval = ({ request, sending, respond }: CardProps<"plan.requested">) => {
  const [feedback, setFeedback] = useState("");
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(request.plan);
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const toggled = useRef(false);
  // Focus follows the editor: into it when it opens, back to Edit when it closes.
  useEffect(() => {
    if (toggled.current) (editing ? field.current : editButton.current)?.focus();
  }, [editing]);
  const edit = (on: boolean) => {
    toggled.current = true;
    setEdited(request.plan);
    setEditing(on);
  };
  if (editing)
    return (
      <>
        <h3 className="font-serif text-lg font-semibold">Edit the plan, then approve it and build</h3>
        <label htmlFor={`${id}-plan`} className="mt-2 mb-1 block text-xs font-medium text-muted">
          Plan (the agent builds from your edit)
        </label>
        <textarea
          ref={field}
          id={`${id}-plan`}
          rows={Math.min(20, edited.split("\n").length + 1)}
          className="w-full font-mono text-xs"
          value={edited}
          onChange={(e) => setEdited(e.target.value)}
        />
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <button type="button" disabled={sending} onClick={() => edit(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="border-go bg-go text-on-go hover:bg-go-hover"
            disabled={sending || !edited.trim()}
            onClick={() => respond({ decision: "allow", plan: edited })}
          >
            Approve with edits
          </button>
        </div>
      </>
    );
  return (
    <>
      <h3 className="font-serif text-lg font-semibold">Approve the plan above and build it?</h3>
      {request.filePath && <p className="font-mono text-xs text-muted">{request.filePath}</p>}
      {request.execute && (
        <p className="mt-1 text-accent">
          Approving moves the build to {request.execute.target.model} · {request.execute.effort}: {request.execute.reason}
        </p>
      )}
      <label htmlFor={id} className="mt-2 mb-1 block text-xs font-medium text-muted">
        Feedback if you keep planning (optional)
      </label>
      <textarea id={id} rows={2} className="w-full" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button type="button" ref={editButton} disabled={sending} onClick={() => edit(true)}>
          Edit
        </button>
        <button
          type="button"
          disabled={sending}
          onClick={() => respond(feedback.trim() ? { decision: "deny", feedback: feedback.trim() } : { decision: "deny" })}
        >
          Keep planning
        </button>
        <button
          type="button"
          className="border-go bg-go text-on-go hover:bg-go-hover"
          disabled={sending}
          onClick={() => respond({ decision: "allow" })}
        >
          Approve and build
        </button>
      </div>
    </>
  );
};

/** Each question takes its picked options (multi-select joined with ", "), or a typed answer instead. */
const Questions = ({ request, sending, respond }: CardProps<"user-input.requested">) => {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const answerOf = (q: Question) => typed[q.question]?.trim() || (picked[q.question] ?? []).join(", ");
  const complete = request.questions.every((q) => answerOf(q) !== "");
  const toggle = (q: Question, label: string) =>
    setPicked((p) => {
      const current = p[q.question] ?? [];
      const next = q.multiSelect ? (current.includes(label) ? current.filter((l) => l !== label) : [...current, label]) : [label];
      return { ...p, [q.question]: next };
    });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (complete)
      void respond({ decision: "answer", answers: Object.fromEntries(request.questions.map((q) => [q.question, answerOf(q)])) });
  };
  return (
    <form onSubmit={onSubmit}>
      {request.questions.map((q) => (
        <fieldset key={q.question} className="my-2 rounded-lg border border-line px-3 pt-1 pb-2">
          <legend>
            <strong>{q.header}</strong> {q.question}
          </legend>
          {q.options.map((o) => (
            <label key={o.label} className="-mx-1.5 block rounded-md px-1.5 py-1 hover:bg-hover has-checked:bg-hover">
              <input
                type={q.multiSelect ? "checkbox" : "radio"}
                name={q.question}
                checked={(picked[q.question] ?? []).includes(o.label)}
                onChange={() => toggle(q, o.label)}
              />
              {o.label} <span className="text-muted">{o.description}</span>
            </label>
          ))}
          <label className="mt-1 flex flex-wrap items-center gap-2 text-muted">
            Or your own answer
            <input
              type="text"
              value={typed[q.question] ?? ""}
              onChange={(e) => setTyped((t) => ({ ...t, [q.question]: e.target.value }))}
            />
          </label>
        </fieldset>
      ))}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button type="button" disabled={sending} onClick={() => respond({ decision: "deny" })}>
          Skip
        </button>
        <button type="submit" disabled={sending || !complete}>
          Answer
        </button>
      </div>
    </form>
  );
};
