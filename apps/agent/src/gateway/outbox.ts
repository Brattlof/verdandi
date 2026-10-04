import { type Button, type ChannelBinding, clip, type Event, type ThreadId, trustSubjects } from "@verdandi/contracts";

/**
 * The outbox's pure half (DESIGN §15): what a bound thread's chat gets, decided with the events that cause it, so a
 * reply or a request is committed together with the turn's own event and can't be lost between the two.
 */

/** The command's thread's binding, when it has one, and the running turn's last reply, loaded for a turn that may end. */
export type ChannelState = { readonly threadId: ThreadId; readonly binding: ChannelBinding; readonly reply?: string };

const answerButtons = (requestId: string, allow = "Approve", deny = "Deny"): readonly Button[] => [
  { label: allow, command: `approve ${requestId}` },
  { label: deny, command: `deny ${requestId}` },
];

type RequestEvent = Extract<
  Event,
  {
    type:
      | "approval.requested"
      | "user-input.requested"
      | "plan.requested"
      | "skill.proposed"
      | "memory.proposed"
      | "commands.trust.requested";
  }
>;

/** Each request as a chat message: what it asks, and buttons that answer it. */
const requests: {
  readonly [K in RequestEvent["type"]]: (e: Extract<RequestEvent, { type: K }>) => { text: string; buttons: readonly Button[] };
} = {
  "approval.requested": (e) => ({
    text: `The agent asks to use ${e.toolName}: ${clip(JSON.stringify(e.input), 400)}`,
    buttons: answerButtons(e.requestId, "Allow"),
  }),
  // ponytail: a question is answered from the terminal chat or the web UI; chat apps can only decline it. Option buttons
  // when Telegram answers come in.
  "user-input.requested": (e) => ({
    text: `The agent asks:\n${e.questions
      .map((q) => `${q.question}\n${q.options.map((o, i) => `  ${i + 1}. ${o.label}: ${o.description}`).join("\n")}`)
      .join("\n\n")}\n\nAnswer it in the terminal chat or the web UI, or decline it here.`,
    buttons: [{ label: "Decline", command: `deny ${e.requestId}` }],
  }),
  "plan.requested": (e) => ({
    text: `The agent proposes this plan:\n\n${e.plan}${e.execute ? `\n\nApproving moves the build to ${e.execute.target.model} ${e.execute.effort}.` : ""}`,
    buttons: answerButtons(e.requestId, "Approve and build", "Reject"),
  }),
  "skill.proposed": (e) => ({
    text: `The agent proposes to ${e.change.action} the skill ${e.change.skill}${e.change.path ? ` (${e.change.path})` : ""}. Its diff is in the terminal chat and the web UI.`,
    buttons: answerButtons(e.requestId),
  }),
  "memory.proposed": (e) => ({
    text: `Verdandi proposes remembering, in ${e.scope === "user" ? "your user" : "the project's"} memory:\n${e.text}`,
    buttons: answerButtons(e.requestId, "Remember it", "Don't"),
  }),
  "commands.trust.requested": (e) => ({
    text: `Verdandi would run ${trustSubjects[e.purpose]}: ${e.commands.map((c) => `\`${c}\``).join(", ")}. Allowing trusts this list in the project.`,
    buttons: answerButtons(e.requestId, "Allow"),
  }),
};

const isRequest = (e: Event): e is RequestEvent => Object.hasOwn(requests, e.type);

/** What a finished turn sends: its last reply, and how it ended unless it simply succeeded. */
const replyText = (e: Extract<Event, { type: "turn.completed" }>, reply: string | undefined) => {
  const ended = e.status === "success" ? "" : `The turn ended: ${e.status}${e.error ? ` (${e.error})` : ""}.`;
  return [reply, ended].filter(Boolean).join("\n\n") || "Done.";
};

/** `events`, each followed by the delivery it asks for when the thread is bound: a finished turn's reply, or a request. */
export const withDeliveries = (channel: ChannelState | undefined, events: readonly Event[]): Event[] =>
  events.flatMap((e): Event[] => {
    if (!channel || e.threadId !== channel.threadId) return [e];
    const { threadId, binding } = channel;
    if (e.type === "turn.completed")
      return [
        e,
        {
          type: "delivery.requested",
          v: 1,
          threadId,
          deliveryId: `reply:${e.turnId}`,
          turnId: e.turnId,
          binding,
          text: replyText(e, channel.reply),
          buttons: [],
        },
      ];
    if (!isRequest(e)) return [e];
    const { text, buttons } = (requests[e.type] as (r: RequestEvent) => { text: string; buttons: readonly Button[] })(e);
    return [
      e,
      {
        type: "delivery.requested",
        v: 1,
        threadId,
        deliveryId: `request:${e.requestId}`,
        turnId: e.turnId,
        binding,
        text,
        buttons: [...buttons],
      },
    ];
  });

/** Where a delivery stands, as `deliveries.state` keeps it. */
export type DeliveryState = "requested" | "attempted" | "sent" | "failed" | "abandoned";
