import type { CommandId, InteractionMode, Question, Resolution, ThreadId, ThreadView, TurnId } from "@verdandi/contracts";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useState } from "react";
import { type Connection, type Routed, uuid } from "./client.ts";
import { RouteChip } from "./route.tsx";
import type { LiveThread } from "./state.ts";

const modes: { value: InteractionMode; label: string; hint: string }[] = [
  { value: "ask", label: "Ask", hint: "answers without changing anything" },
  { value: "plan", label: "Plan", hint: "proposes a plan for you to approve first" },
  { value: "build", label: "Build", hint: "does the work" },
];

/**
 * Sends the next turn in the chosen mode. While a turn runs, a message steers it instead: the agent
 * reads it at its next step (ADR 0003). Enter sends, Shift+Enter starts a new line.
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
  const running = thread.turns.findLast((t) => t.status === "running");
  const { threadId } = thread;

  const fail = (message: string, body: string) => {
    setError(message);
    setText((current) => current || body);
  };
  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    setError(undefined);
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
    });
    if (!sent.ok) fail(sent.message, body);
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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const hint = modes.find((m) => m.value === mode)?.hint;
  // Only a message that starts a routed task gets a preview: one that continues a task keeps its route.
  const preview = !running && !thread.pinned && thread.task === null;
  return (
    <div className="mx-auto w-full max-w-[860px] px-4 pt-2 pb-3">
      <RouteChip connection={connection} thread={thread} />
      <form onSubmit={onSubmit}>
        <fieldset className="mb-1 flex items-center gap-3">
          <legend className="sr-only">Mode for the next turn</legend>
          {modes.map((m) => (
            <label key={m.value}>
              <input type="radio" name="mode" value={m.value} checked={mode === m.value} onChange={() => onMode(m.value)} />
              {m.label}
            </label>
          ))}
          <span className="text-xs text-muted">
            {hint}
            {running ? "; applies from the next turn" : ""}
          </span>
        </fieldset>
        <label className="sr-only" htmlFor="message">
          {running ? "Steer the running turn" : "Message"}
        </label>
        <textarea
          id="message"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="w-full resize-y"
          placeholder={running ? "Steer the agent: it reads this at its next step" : "Message the agent"}
          aria-describedby={preview ? "route-preview" : undefined}
        />
        {preview && <RoutePreview connection={connection} thread={thread} text={text} mode={mode} />}
        <div className="mt-1.5 flex items-center justify-end gap-2">
          {error && (
            <span role="alert" className="mr-auto text-error">
              {error}
            </span>
          )}
          {running && (
            <button type="button" onClick={stop}>
              Stop
            </button>
          )}
          <button type="submit" disabled={!text.trim()}>
            {running ? "Steer" : "Send"}
          </button>
        </div>
      </form>
    </div>
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
  mode,
}: {
  connection: Connection;
  thread: LiveThread;
  text: string;
  mode: InteractionMode;
}) => {
  const [routed, setRouted] = useState<Routed>();
  const draft = text.trim();
  const { threadId } = thread;
  useEffect(() => {
    if (!draft) return setRouted(undefined);
    let current = true;
    const timer = setTimeout(() => void connection.simulate(threadId, draft, mode).then((r) => current && setRouted(r)), 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [connection, threadId, draft, mode]);
  const decision = routed?.ok ? routed.decision : undefined;
  return (
    <p id="route-preview" className="mt-1 text-xs text-muted" aria-live="polite">
      {!draft || !routed
        ? "The router picks a route when you send."
        : decision
          ? `Routes to ${decision.target.model} · ${decision.effort} on ${decision.target.harness}: ${decision.reason}`
          : !routed.ok && <span className="text-error">{routed.message}</span>}
    </p>
  );
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
    <section className="max-h-[45vh] overflow-y-auto border-t border-line" aria-label="Waiting for your answer">
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
    <div className="mx-auto max-w-[860px] px-4 py-2">
      {request.type === "approval.requested" && <Approval request={request} sending={sending} respond={respond} />}
      {request.type === "user-input.requested" && <Questions request={request} sending={sending} respond={respond} />}
      {request.type === "plan.requested" && <PlanApproval request={request} sending={sending} respond={respond} />}
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
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
    <h3 className="my-1 font-bold">Allow {request.toolName}?</h3>
    <pre>{JSON.stringify(request.input, null, 2)}</pre>
    <div className="mt-1.5 flex items-center justify-end gap-2">
      <button type="button" disabled={sending} onClick={() => respond({ decision: "deny" })}>
        Deny
      </button>
      <button type="button" disabled={sending} onClick={() => respond({ decision: "allow" })}>
        Allow
      </button>
    </div>
  </>
);

const PlanApproval = ({ request, sending, respond }: CardProps<"plan.requested">) => {
  const [feedback, setFeedback] = useState("");
  const id = useId();
  return (
    <>
      <h3 className="my-1 font-bold">Approve the plan above and build it?</h3>
      {request.filePath && <p className="text-muted">{request.filePath}</p>}
      <label htmlFor={id}>Feedback if you keep planning (optional)</label>
      <textarea id={id} rows={2} className="w-full" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={sending}
          onClick={() => respond(feedback.trim() ? { decision: "deny", feedback: feedback.trim() } : { decision: "deny" })}
        >
          Keep planning
        </button>
        <button type="button" disabled={sending} onClick={() => respond({ decision: "allow" })}>
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
        <fieldset key={q.question} className="my-1 rounded border border-line px-3 pt-1 pb-2">
          <legend>
            <strong>{q.header}</strong> {q.question}
          </legend>
          {q.options.map((o) => (
            <label key={o.label} className="my-0.5 block">
              <input
                type={q.multiSelect ? "checkbox" : "radio"}
                name={q.question}
                checked={(picked[q.question] ?? []).includes(o.label)}
                onChange={() => toggle(q, o.label)}
              />
              {o.label} <span className="text-muted">{o.description}</span>
            </label>
          ))}
          <label className="my-0.5 block">
            Or your own answer{" "}
            <input
              type="text"
              value={typed[q.question] ?? ""}
              onChange={(e) => setTyped((t) => ({ ...t, [q.question]: e.target.value }))}
            />
          </label>
        </fieldset>
      ))}
      <div className="mt-1.5 flex items-center justify-end gap-2">
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
