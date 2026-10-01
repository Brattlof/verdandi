import { Effect } from "effect";
import { defineTool, type ToolAt, type ToolFailed } from "./define.ts";

/**
 * `report_blocked` (DESIGN §8.7, §9.6): the agent says it can't finish the task as asked. Verdandi records it
 * on the task, where the escalation ladder reads it, and shows the reason on the turn.
 */
export const reportBlockedTool = (block: (reason: string, at: ToolAt) => Effect.Effect<void, ToolFailed>) =>
  defineTool({
    name: "report_blocked",
    description:
      "Tell Verdandi you can't finish the task as asked: access you don't have, a decision only the user can make, a broken environment, or a requirement that contradicts itself. Verdandi records it on the task and shows the reason to the user. Call it once, then stop and explain in your reply.",
    params: { reason: { type: "string", description: "What blocks you and what would unblock you, in a sentence or two." } },
    run: ({ reason }, at) =>
      Effect.as(block(reason, at), "Recorded: the user sees that you're blocked, and why. Stop here and explain in your reply."),
  });
