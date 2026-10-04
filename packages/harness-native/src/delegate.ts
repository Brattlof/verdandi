import type Anthropic from "@anthropic-ai/sdk";
import { SubagentProfile } from "@verdandi/contracts";
import { Schema } from "effect";
import type { Entry } from "./transcript.ts";

/** The native agent's tool for handing a subtask to a child session (DESIGN §9.4). */
export const delegateTool = "delegate_task";

export const delegateDefinition: Anthropic.Tool = {
  name: delegateTool,
  description:
    "Hands a self-contained subtask to a subagent: a fresh session that doesn't see this conversation, which Verdandi routes as a task of its own, often to a cheaper model. Use it for work that doesn't need your context, such as finding where something is, reading and summarizing files, mechanical edits or a review, and keep the judgment for yourself. Write `task` so it stands alone: the goal, the files and names it needs, and what to report back. Name `profile` explorer for read-only searching, or reviewer for reviewing a change; both work read-only, and so does every subagent while you're in ask or plan mode. Several calls in one reply run at the same time. The result is the subagent's final reply.",
  input_schema: {
    type: "object",
    properties: {
      task: { type: "string", description: "The whole subtask, as the subagent should read it." },
      profile: { type: "string", enum: [...SubagentProfile.literals], description: "explorer or reviewer; leave it out for other work." },
    },
    required: ["task"],
  },
};

/** The call's subtask and profile, or why they're unusable. */
export const delegateArgs = (args: Readonly<Record<string, unknown>>) => {
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (task === "") return { error: "`task` is required: the whole subtask, as the subagent should read it." } as const;
  if (args.profile === undefined) return { task } as const;
  const profile = Schema.decodeUnknownOption(SubagentProfile)(args.profile);
  if (profile._tag === "None") return { error: "`profile` is explorer or reviewer; leave it out for other work." } as const;
  return { task, profile: profile.value } as const;
};

/** What a finished child hands back: the text of its last reply. */
export const summaryOf = (entries: readonly Entry[]) => {
  const last = entries.findLast((e) => e.message.role === "assistant")?.message;
  const text = (last?.content ?? []).flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n");
  return text.trim() === "" ? "The subagent finished without a reply." : text;
};

/**
 * Runs `runs` at most `limit` at a time, yielding their events as they come, and returns their results in their order.
 * A run that throws fails the whole; the others are left to their own abort signal.
 */
export async function* concurrently<E, R>(runs: readonly (() => AsyncGenerator<E, R>)[], limit: number): AsyncGenerator<E, R[]> {
  const results: R[] = [];
  const active = new Map<
    number,
    { readonly run: AsyncGenerator<E, R>; next: Promise<{ readonly i: number; readonly step: IteratorResult<E, R> }> }
  >();
  const pull = (i: number, run: AsyncGenerator<E, R>) => run.next().then((step) => ({ i, step }));
  let started = 0;
  const fill = () => {
    for (; active.size < limit && started < runs.length; started++) {
      const run = runs[started]?.();
      if (run) active.set(started, { run, next: pull(started, run) });
    }
  };
  fill();
  while (active.size > 0) {
    const { i, step } = await Promise.race([...active.values()].map((a) => a.next));
    const entry = active.get(i);
    if (!entry) continue;
    if (step.done) {
      results[i] = step.value;
      active.delete(i);
      fill();
      continue;
    }
    entry.next = pull(i, entry.run);
    yield step.value;
  }
  return results;
}
