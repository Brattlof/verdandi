import {
  describeRouteChange,
  type Event,
  isCorrection,
  type Route,
  type StoredEvent,
  type TaskId,
  type TaskOutcome,
  type TaskRating,
  type TaskStatus,
  type ThreadId,
  type Usage,
} from "@verdandi/contracts";

type TurnStatus = Extract<Event, { type: "turn.completed" }>["status"];

const taskStatus: Record<TurnStatus, TaskStatus> = { success: "completed", error: "failed", interrupted: "abandoned", limit: "limit" };

type Draft = {
  readonly taskId: TaskId;
  readonly threadId: ThreadId;
  readonly route: Route;
  /** The route the task runs on now: an approved plan moves it off `route`. */
  current: Route;
  turns: number;
  /** The status of the task's last turn; undefined while that turn runs. */
  last: TurnStatus | undefined;
  startedMs: number;
  wallMs: number;
  corrections: number;
  override: { readonly from: Route; readonly to: Route } | undefined;
  readonly verifierRuns: { command: string; passed: boolean }[];
  escalations: number;
  fallbacks: number;
  readonly triggers: TaskOutcome["triggers"][number][];
  readonly usage: Map<string, Usage>;
  rating: TaskRating | null;
};

/** The event types `buildTaskOutcomes` reads, so a caller can load only these: a turn's items are most of a thread. */
export const outcomeEventTypes = [
  "task.started",
  "task.rated",
  "thread.reverted",
  "thread.revert.undone",
  "thread.route.changed",
  "task.rerouted",
  "task.escalated",
  "task.deescalated",
  "turn.rerouted",
  "turn.started",
  "turn.steered",
  "verifier.ran",
  "decision.recorded",
  "plan.requested",
  "approval.resolved",
  "turn.usage.recorded",
  "turn.completed",
] as const satisfies readonly Event["type"][];
const outcomeEvents = new Set<string>(outcomeEventTypes);
/** Narrows to the listed types, so a case for any other type below fails to typecheck until it's listed. */
const read = (e: Event): e is Extract<Event, { type: (typeof outcomeEventTypes)[number] }> => outcomeEvents.has(e.type);

/**
 * Pure: the outcome of each task in a thread's events, in `seq` order, whose last turn has ended. A task
 * runs from its `task.started` to the next one; turns from before tasks existed belong to none.
 */
export const buildTaskOutcomes = (events: readonly StoredEvent[]): TaskOutcome[] => {
  const tasks: Draft[] = [];
  const plans = new Set<string>();
  /** Each turn's task, and the turns the user has reverted: a task with one is `reverted` (DESIGN §13). */
  const taskOf = new Map<string, Draft>();
  const reverted = new Set<string>();
  /** The task of the latest turn: a follow-up correcting the agent, recorded before its own turn starts, corrects that task. */
  let current: Draft | undefined;
  for (const { event: e, at } of events) {
    if (!read(e)) continue;
    if (e.type === "task.started") {
      tasks.push({
        ...e,
        current: e.route,
        turns: 0,
        last: undefined,
        startedMs: 0,
        wallMs: 0,
        corrections: 0,
        override: undefined,
        verifierRuns: [],
        escalations: 0,
        fallbacks: 0,
        triggers: [],
        usage: new Map(),
        rating: null,
      });
      continue;
    }
    // The user can rate any of the thread's tasks, not only the latest.
    if (e.type === "task.rated") {
      const rated = tasks.find((t) => t.taskId === e.taskId);
      if (rated) rated.rating = e.rating;
      continue;
    }
    if (e.type === "thread.reverted" || e.type === "thread.revert.undone") {
      for (const turnId of e.turnIds) e.type === "thread.reverted" ? reverted.add(turnId) : reverted.delete(turnId);
      continue;
    }
    const task = tasks.at(-1);
    if (!task) continue;
    switch (e.type) {
      case "thread.route.changed":
        // The user's last pick counts. Pinning the route the task runs on, or changing back to it, overrides nothing.
        task.override = describeRouteChange(task.current, e.to) === "" ? undefined : { from: task.current, to: e.to };
        break;
      // Neither moves the task off the route it started on, nor overrides it.
      case "task.rerouted":
      case "task.deescalated":
        task.current = e.to;
        break;
      // At `ask` nothing moved.
      case "task.escalated":
        task.triggers.push({ trigger: e.trigger, step: e.step });
        if (e.to) {
          task.current = e.to;
          task.escalations++;
        }
        break;
      // A fallback moves one turn, never the task's route.
      case "turn.rerouted":
        task.fallbacks++;
        break;
      case "turn.started":
        taskOf.set(e.turnId, task);
        current = task;
        task.turns++;
        task.last = undefined;
        task.startedMs = Date.parse(at);
        break;
      case "turn.steered":
        task.corrections++;
        break;
      case "verifier.ran":
        task.verifierRuns.push({ command: e.command, passed: e.passed });
        break;
      case "decision.recorded":
        if (current && e.answers.some(isCorrection)) current.corrections++;
        break;
      case "plan.requested":
        plans.add(e.requestId);
        break;
      case "approval.resolved": {
        // A `reason` means Verdandi denied it because the turn ended; only the user rejecting or editing a plan is a correction.
        const { resolution } = e;
        const corrected = resolution.decision === "deny" || (resolution.decision === "allow" && resolution.plan !== undefined);
        if (plans.has(e.requestId) && corrected && e.reason === undefined) task.corrections++;
        break;
      }
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
    // Satisfaction counts the corrections Verdandi sees (steers, interrupts, rejected or edited plans, a route override,
    // follow-ups the decision layer calls corrections); the user's own word is `rating`.
    const corrections = t.corrections + (t.override ? 1 : 0);
    // A task whose agent finished but whose last verifier run failed didn't get its work right.
    const status = [...reverted].some((turnId) => taskOf.get(turnId) === t)
      ? "reverted"
      : t.last === "success" && t.verifierRuns.at(-1)?.passed === false
        ? "failed"
        : taskStatus[t.last];
    return [
      {
        v: 4,
        taskId: t.taskId,
        threadId: t.threadId,
        route: t.route,
        status,
        turns: t.turns,
        implicitSatisfaction: Math.max(-1, 1 - corrections),
        ...(t.override ? { userOverride: t.override } : {}),
        verifierRuns: t.verifierRuns,
        escalations: t.escalations,
        triggers: t.triggers,
        fallbacks: t.fallbacks,
        usage: [...t.usage.values()],
        wallMs: t.wallMs,
        ...(t.rating === null ? {} : { rating: t.rating }),
      },
    ];
  });
};
