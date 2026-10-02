import type { ChatMessage, MessageExample, Trajectory } from "@verdandi/contracts";

type ToolCall = NonNullable<Extract<ChatMessage, { role: "assistant" }>["tool_calls"]>[number];

/**
 * Pure: each task's turns, in the order given, as one OpenAI-style conversation (DESIGN §14.6). A turn from before
 * tasks existed is a conversation of its own. Only the main agent's steps count: a subagent's run inside the tool
 * call that started it, whose result is kept. A steer recorded while tool calls were open joins after their results,
 * so every tool call is followed by its results. Verdandi's own items (verifiers, route switches, notices) are left out;
 * plans are the harness's own tool calls. Redact the trajectories first.
 */
export const toMessageExamples = (trajectories: readonly Trajectory[]): MessageExample[] => {
  const tasks = Map.groupBy(trajectories, (t) => t.taskId ?? t.turnId);
  return [...tasks.values()].map((turns) => {
    const messages: ChatMessage[] = [];
    for (const turn of turns) {
      messages.push({ role: "user", content: turn.text });
      const open = new Set<string>();
      const steers: string[] = [];
      const flush = () => {
        for (const content of steers.splice(0)) messages.push({ role: "user", content });
      };
      for (const item of turn.items) {
        if ("parentToolUseId" in item && item.parentToolUseId !== undefined) continue;
        if (item.kind === "assistant.message") messages.push({ role: "assistant", content: item.text });
        else if (item.kind === "user.steer") {
          steers.push(item.text);
          if (open.size === 0) flush();
        } else if (item.kind === "tool.call") {
          const call: ToolCall = {
            id: item.toolUseId,
            type: "function",
            function: { name: item.name, arguments: JSON.stringify(item.input ?? {}) },
          };
          const last = messages.at(-1);
          // Calls made together (and the text before them) are one assistant message.
          if (last?.role === "assistant") messages[messages.length - 1] = { ...last, tool_calls: [...(last.tool_calls ?? []), call] };
          else messages.push({ role: "assistant", content: null, tool_calls: [call] });
          open.add(item.toolUseId);
        } else if (item.kind === "tool.result") {
          messages.push({ role: "tool", tool_call_id: item.toolUseId, content: item.content });
          open.delete(item.toolUseId);
          if (open.size === 0) flush();
        }
      }
      flush();
    }
    const first = turns[0] as Trajectory;
    const last = turns.at(-1) as Trajectory;
    return {
      messages,
      metadata: {
        v: 1,
        ...(first.taskId ? { taskId: first.taskId } : {}),
        threadId: first.threadId,
        projectId: first.projectId,
        route: first.route,
        status: last.outcome.status,
      },
    };
  });
};
