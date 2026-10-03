import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Catalog,
  decodeStoredEvent,
  type HarnessId,
  type InteractionMode,
  listCost,
  type ProjectId,
  type Route,
  type RouteInputs,
  type TaskClass,
  type TaskId,
  type TaskOutcome,
  type Usage,
} from "@verdandi/contracts";
import { nativeCatalog } from "@verdandi/harness-native";
import { builtInCatalog, loadPolicy, PolicyError } from "@verdandi/router";
import { fakeCatalog } from "@verdandi/testkit";
import { Effect, Result } from "effect";
import { decideRoute, projectRouting, type RoutingContext, replayed, routeOf, rulesDecide, taskQuestions } from "./routing.ts";

/** A saved task as replay reads it: what started it, what the router knew, and the tokens it used. */
export type SavedTask = {
  readonly taskId: TaskId;
  readonly projectPath: string;
  readonly text: string;
  readonly mode: InteractionMode;
  /** How many images its first turn had attached. */
  readonly images: number;
  /** The route it started on, and its class then; the class is null for tasks from before routing. */
  readonly route: Route;
  readonly taskClass: TaskClass | null;
  /** Null for tasks recorded before `task.started` kept the router's inputs. */
  readonly inputs: RouteInputs | null;
  /** Whether a v1 task's thread was pinned: its decision says, and tasks from before routing always were. */
  readonly pinnedBefore: boolean;
  readonly usage: readonly Usage[];
};

export type ReplayedTask = {
  readonly task: SavedTask;
  readonly to: Route;
  readonly taskClass: TaskClass;
  readonly reason: string;
  /** The task's recorded tokens at the catalog list price of the route it ran on and the one it would run on; null when the catalog doesn't know one. */
  readonly costFrom: number | null;
  readonly costTo: number | null;
};

export type Replay = {
  /** Where the policy came from: the proposed file, or each project's own. */
  readonly policy: string;
  readonly tasks: readonly ReplayedTask[];
  /** Tasks the router couldn't route under the policy, with why. */
  readonly failed: readonly { readonly task: SavedTask; readonly message: string }[];
  /** Inputs assumed for tasks recorded before they were kept, when there are any. */
  readonly assumed: string | undefined;
};

/** Every model a recorded task could have run on: the built-in ones, and the native and fake harnesses'. */
const catalog: Catalog = [...builtInCatalog, ...nativeCatalog, ...fakeCatalog];

/** What the router is assumed to have read for a task from before its inputs were recorded. */
const assumedHarnesses: readonly HarnessId[] = ["claude-code"];
export const assumedInputs = (task: Pick<SavedTask, "route" | "pinnedBefore">): RouteInputs => ({
  route: task.route,
  pinned: task.pinnedBefore,
  budgetMode: null,
  warm: false,
  cachedTokens: 0,
  harnesses: [...new Set([...assumedHarnesses, task.route.harness])],
});
const assumption =
  "no warm session, the policy's budget mode, no routing memory, and verdandid running claude-code and the task's own harness";

const priced = (route: Route, usage: readonly Usage[]) => {
  const entry = catalog.find((e) => e.harness === route.harness && e.model === route.model);
  return entry ? usage.reduce((sum, u) => sum + listCost(entry.price, u), 0) : null;
};

export const sameRoute = (a: Route, b: Route) => a.harness === b.harness && a.model === b.model && a.effort === b.effort;

/**
 * Pure: `task` routed again under `policy`, classified by the decision layer as it is now, with the inputs
 * the router read when the task started (DESIGN §8.8 level 2). Fails with the router's message.
 */
export const replayTask = (task: SavedTask, policy: Pick<RoutingContext, "policy" | "builtIn">): Result.Result<ReplayedTask, string> => {
  const { thread, routing } = replayed(task.inputs ?? assumedInputs(task), policy);
  const { answers } = Effect.runSync(rulesDecide.decide({ state: task.text, questions: taskQuestions(routing) }));
  const decided = decideRoute(thread, routing, task.text, task.mode, answers, task.images, task.inputs?.at);
  if (Result.isFailure(decided)) return Result.fail(decided.failure.message);
  const to = routeOf(decided.success);
  return Result.succeed({
    task,
    to,
    taskClass: decided.success.taskClass,
    reason: decided.success.reason,
    costFrom: priced(task.route, task.usage),
    costTo: priced(to, task.usage),
  });
};

/** The home's database, opened read-only: replay, export and decision evals never write, and verdandid may be running on it. */
export const openReadOnly = (home: string) => {
  const file = join(home, "verdandi.db");
  if (!existsSync(file))
    throw new Error(`No Verdandi database in ${home}. Pass the profile's home with --home, or run verdandi start once.`);
  return new Database(file, { readonly: true });
};

/** Every saved task, oldest first, or only `projectId`'s. */
export const loadSavedTasks = (home: string, projectId?: ProjectId): SavedTask[] => {
  const db = openReadOnly(home);
  try {
    const rows = db
      .query<
        {
          type: string;
          v: number;
          payload: string;
          path: string;
          text: string | null;
          mode: InteractionMode | null;
          images: number | null;
          outcome: string | null;
        },
        [string | null]
      >(
        `select e.type, e.v, e.payload, p.path, t.text, t.mode, o.payload as outcome,
           (select count(*) from json_each(t.attachments) where json_extract(value, '$.kind') = 'image') as images
         from events e join threads h on h.id = e.thread_id join projects p on p.id = h.project_id
           left join turns t on t.id = json_extract(e.payload, '$.taskId')
           left join task_outcomes o on o.task_id = json_extract(e.payload, '$.taskId')
         where e.type = 'task.started' and (?1 is null or h.project_id = ?1)
         order by e.seq`,
      )
      .all(projectId ?? null);
    return rows.flatMap((row) => {
      const e = Effect.runSync(decodeStoredEvent(row));
      if (e.type !== "task.started" || row.text === null) return [];
      return [
        {
          taskId: e.taskId,
          projectPath: row.path,
          text: row.text,
          mode: row.mode ?? "build",
          images: row.images ?? 0,
          route: e.route,
          taskClass: e.decision?.taskClass ?? null,
          inputs: e.inputs ?? null,
          pinnedBefore: e.decision ? e.decision.source === "pin" : true,
          usage: row.outcome === null ? [] : (JSON.parse(row.outcome) as TaskOutcome).usage,
        },
      ];
    });
  } finally {
    db.close();
  }
};

/**
 * Replays `tasks` under the policy in `policyFile`, layered over the built-in one as a project's would be,
 * or under each task's project's own `.verdandi/routing.yaml` as it is now. A broken policy file throws,
 * naming the file and the key.
 */
export const replay = (tasks: readonly SavedTask[], policyFile?: string): Replay => {
  const builtIn = loadPolicy([], catalog);
  const proposed = policyFile === undefined ? undefined : loadProposed(policyFile);
  const projectPolicies = new Map<string, Pick<RoutingContext, "policy" | "builtIn">>();
  const policyFor = (projectPath: string) => {
    if (proposed) return { policy: Result.succeed(proposed), builtIn };
    const known = projectPolicies.get(projectPath);
    if (known) return known;
    const loaded = Effect.runSync(projectRouting([], catalog)(projectPath));
    if (Result.isFailure(loaded.policy)) throw new Error(loaded.policy.failure);
    projectPolicies.set(projectPath, loaded);
    return loaded;
  };
  const replayedTasks: ReplayedTask[] = [];
  const failed: { task: SavedTask; message: string }[] = [];
  for (const task of tasks) {
    const result = replayTask(task, policyFor(task.projectPath));
    if (Result.isSuccess(result)) replayedTasks.push(result.success);
    else failed.push({ task, message: result.failure });
  }
  return {
    policy: policyFile ?? "each project's .verdandi/routing.yaml as it is now",
    tasks: replayedTasks,
    failed,
    assumed: tasks.some((t) => t.inputs === null) ? assumption : undefined,
  };
};

const loadProposed = (file: string) => {
  if (!existsSync(file)) throw new Error(`Policy file not found: ${file}. Check the path.`);
  try {
    return loadPolicy([{ source: file, data: Bun.YAML.parse(readFileSync(file, "utf8")) }], catalog);
  } catch (e) {
    if (e instanceof PolicyError) throw new Error(`${e.message}\nFix the file and replay again.`);
    throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}\nFix the file and replay again.`);
  }
};
