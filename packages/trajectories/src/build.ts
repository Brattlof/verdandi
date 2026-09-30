import type { HarnessId, Item, Provider, StoredEvent, TaskId, Trajectory, TurnId } from "@verdandi/contracts";

// ponytail: each harness talks to one provider today. The native harness (M4) routes to many, and will
// report the provider per turn instead.
const providerOf: Record<HarnessId, Provider> = { "claude-code": "anthropic", fake: "fake" };

/**
 * Pure: the trajectory of `turnId` from its thread's events in `seq` order, or undefined until the turn
 * has completed. Thread-level events (creation, task starts, route changes, session bindings) set the context; only
 * the turn's own events add to it. The turn belongs to the last task started before it.
 */
export const buildTrajectory = (events: readonly StoredEvent[], turnId: TurnId): Trajectory | undefined => {
  let thread: Pick<Trajectory, "threadId" | "projectId" | "route"> | undefined;
  let session: { readonly sessionId: string; readonly harnessVersion: string; readonly transcriptPath?: string } | undefined;
  let turn: Pick<Trajectory, "text" | "mode" | "startedAt"> | undefined;
  let taskId: TaskId | undefined;
  const items: Item[] = [];
  const usage: Trajectory["usage"][number][] = [];

  for (const { event: e, at } of events) {
    if (e.type === "thread.created") {
      thread = { threadId: e.threadId, projectId: e.projectId, route: e.route };
      continue;
    }
    if (e.type === "thread.route.changed") {
      // Once the turn has started, a route change applies to the next turn. A new harness means a new session.
      if (thread && !turn) thread = { ...thread, route: e.to };
      if (!turn && e.from.harness !== e.to.harness) session = undefined;
      continue;
    }
    if (e.type === "task.started") {
      // The router may pick another route for the task, and a new harness means a new session.
      if (!turn) {
        taskId = e.taskId;
        if (thread && thread.route.harness !== e.route.harness) session = undefined;
        if (thread) thread = { ...thread, route: e.route };
      }
      continue;
    }
    if (e.type === "thread.route.unpinned" || e.type === "thread.budget.changed") continue;
    if (e.type === "harness.session.bound") {
      session = e;
      continue;
    }
    if (e.turnId !== turnId) continue;
    switch (e.type) {
      case "turn.started":
        turn = { text: e.text, mode: e.mode ?? "build", startedAt: at };
        break;
      case "turn.item.added":
        items.push(e.item);
        break;
      case "turn.steered":
        items.push({ kind: "user.steer", text: e.text });
        break;
      case "plan.requested":
        items.push({ kind: "plan", text: e.plan, ...(e.filePath === undefined ? {} : { filePath: e.filePath }) });
        break;
      case "task.rerouted":
        items.push({ kind: "route.switch", from: e.from, to: e.to, reason: e.decision.reason });
        break;
      case "turn.usage.recorded": {
        const { type: _type, v: _v, threadId: _threadId, turnId: _turnId, ...fields } = e;
        usage.push(fields);
        break;
      }
      case "turn.completed": {
        if (!thread || !turn) return undefined;
        const accessMode = usage.length === 0 ? undefined : usage.some((u) => u.accessMode === "metered") ? "metered" : "subscription";
        return {
          v: 1,
          ...thread,
          turnId,
          ...(taskId ? { taskId } : {}),
          ...turn,
          provenance: {
            provider: providerOf[thread.route.harness],
            ...(session ? { harnessVersion: session.harnessVersion } : {}),
            ...(accessMode ? { accessMode } : {}),
          },
          ...(session
            ? { transcript: { sessionId: session.sessionId, ...(session.transcriptPath ? { path: session.transcriptPath } : {}) } }
            : {}),
          items,
          usage,
          outcome: { status: e.status, ...(e.error === undefined ? {} : { error: e.error }) },
          completedAt: at,
        };
      }
    }
  }
  return undefined;
};
