import {
  describeRouteChange,
  type Event,
  type Route,
  type StoredEvent,
  type TaskId,
  type TaskOutcome,
  type TaskStatus,
  type ThreadId,
  type Usage,
} from "@verdandi/contracts";

type TurnStatus = Extract<Event, { type: "turn.completed" }>["status"];

const taskStatus: Record<TurnStatus, TaskStatus> = { success: "completed", error: "failed", interrupted: "abandoned" };

type Draft = {
  readonly taskId: TaskId;
  readonly threadId: ThreadId;
  readonly route: Route;
  turns: number;
  /** The status of the task's last turn; undefined while that turn runs. */
  last: TurnStatus | undefined;
  startedMs: number;
  wallMs: number;
  corrections: number;
  override: { readonly from: Route; readonly to: Route } | undefined;
  readonly usage: Map<string, Usage>;
};

/**
 * Pure: the outcome of each task in a thread's events, in `seq` order, whose last turn has ended. A task
 * runs from its `task.started` to the next one; turns from before tasks existed belong to none.
 */
export const buildTaskOutcomes = (events: readonly StoredEvent[]): TaskOutcome[] => {
  const tasks: Draft[] = [];
  const plans = new Set<string>();
  for (const { event: e, at } of events) {
    if (e.type === "task.started") {
      tasks.push({ ...e, turns: 0, last: undefined, startedMs: 0, wallMs: 0, corrections: 0, override: undefined, usage: new Map() });
      continue;
    }
    const task = tasks.at(-1);
    if (!task) continue;
    switch (e.type) {
      case "thread.route.changed":
        // Pinning the route the router picked keeps the task's route: nothing was overridden.
        if (describeRouteChange(e.from, e.to) !== "") task.override = { from: task.route, to: e.to };
        break;
      case "turn.started":
        task.turns++;
        task.last = undefined;
        task.startedMs = Date.parse(at);
        break;
      case "turn.steered":
        task.corrections++;
        break;
      case "plan.requested":
        plans.add(e.requestId);
        break;
      case "approval.resolved":
        // A `reason` means Verdandi denied it because the turn ended; only the user rejecting a plan is a correction.
        if (plans.has(e.requestId) && e.resolution.decision === "deny" && e.reason === undefined) task.corrections++;
        break;
      case "turn.usage.recorded": {
        const key = `${e.model} ${e.accessMode}`;
        const sum = task.usage.get(key);
        task.usage.set(key, {
          model: e.model,
          accessMode: e.accessMode,
          inputTokens: (sum?.inputTokens ?? 0) + e.inputTokens,
          outputTokens: (sum?.outputTokens ?? 0) + e.outputTokens,
          cacheReadTokens: (sum?.cacheReadTokens ?? 0) + e.cacheReadTokens,
          cacheWriteTokens: (sum?.cacheWriteTokens ?? 0) + e.cacheWriteTokens,
          costUsd: (sum?.costUsd ?? 0) + e.costUsd,
        });
        break;
      }
      case "turn.completed":
        task.last = e.status;
        task.wallMs += Date.parse(at) - task.startedMs;
        // An interrupt without an error is the user's; verdandid stopping sets one.
        if (e.status === "interrupted" && e.error === undefined) task.corrections++;
        break;
    }
  }
  return tasks.flatMap((t): TaskOutcome[] => {
    if (t.last === undefined) return [];
    // ponytail: satisfaction counts only corrections Verdandi sees (steers, interrupts, rejected plans,
    // a route override), and status is the last turn's. Upgrade: classify follow-up turns and read
    // verifier results once the decision layer (M2) and verifiers (M3) exist.
    const corrections = t.corrections + (t.override ? 1 : 0);
    return [
      {
        v: 1,
        taskId: t.taskId,
        threadId: t.threadId,
        route: t.route,
        status: taskStatus[t.last],
        turns: t.turns,
        implicitSatisfaction: Math.max(-1, 1 - corrections),
        ...(t.override ? { userOverride: t.override } : {}),
        verifierRuns: [],
        escalations: 0, // nothing escalates until the router does (DESIGN §8.7)
        usage: [...t.usage.values()],
        wallMs: t.wallMs,
      },
    ];
  });
};
