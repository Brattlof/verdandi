import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type BatchResult,
  type CommandId,
  type CommandRejected,
  defaultRoute,
  EvalSet,
  type EvalTask,
  type HarnessAdapter,
  type HarnessId,
  listCost,
  Route,
  type ThreadId,
  type TurnId,
} from "@verdandi/contracts";
import { Effect, ManagedRuntime, Option, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppLayer } from "../event-store/app.ts";
import { Engine } from "../event-store/engine.ts";
import { Reactor } from "../event-store/reactor.ts";
import { decideRoute, routingFor, rulesDecide, taskQuestions } from "../routing/routing.ts";
import { runVerifier } from "../verifiers/verify.ts";

/** An eval task with its repository resolved against the eval set's folder. */
export type LoadedTask = EvalTask & { readonly repoPath: string };

/** Reads an eval set file (YAML), failing loudly with the file and the bad key. */
export const loadEvalSet = (file: string): readonly LoadedTask[] => {
  let set: EvalSet;
  try {
    set = Schema.decodeUnknownSync(EvalSet)(Bun.YAML.parse(readFileSync(file, "utf8")), { onExcessProperty: "error", errors: "all" });
  } catch (e) {
    throw new Error(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const ids = set.tasks.map((t) => t.id);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) throw new Error(`${file}: task id "${twice}" appears twice; give each task its own id.`);
  return set.tasks.map((t) => ({ ...t, repoPath: resolve(dirname(file), t.repo) }));
};

/** `auto`, or a pinned route written `harness/model/effort`, e.g. `claude-code/opus/medium`. */
export const parseBatchRoute = (spec: string): Route | "auto" => {
  if (spec === "auto") return "auto";
  const [harness, model, effort, ...rest] = spec.split("/");
  const route = rest.length === 0 ? Schema.decodeUnknownOption(Route)({ harness, model, effort }) : Option.none();
  if (Option.isNone(route)) throw new Error(`--route takes auto, or harness/model/effort such as claude-code/opus/medium; not "${spec}".`);
  return route.value;
};

/** DESIGN §8.10's baselines (a) and (b), against the router. */
export const defaultBatchRoutes = ["auto", "claude-code/opus/medium", "claude-code/sonnet/high"];

const git = (cwd: string, args: string[], input = "") => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
};

/**
 * A throwaway copy of the task's repository at its commit. `--shared` borrows the repository's objects, so it's fast
 * and never writes to it. The copy keeps only its detached `HEAD`: every other ref, the `origin` remote and the reflog
 * (which records where the cloned branch pointed) are dropped, so `git log --all`, `git branch -a`, `git tag` and
 * `git fetch` show the agent nothing past the task's commit, such as the commits that fixed what it asks for.
 * ponytail: later commits' objects are still borrowed through `.git/objects/info/alternates`, so an agent that lists
 * every object (`git fsck --lost-found`) can find them. Upgrade: fetch only the task's commit into an empty repository
 * when an eval needs a sealed copy.
 */
export const checkout = (task: LoadedTask) => {
  const dir = mkdtempSync(join(tmpdir(), "verdandi batch "));
  git(dir, ["clone", "--quiet", "--no-checkout", "--shared", task.repoPath, "."]);
  git(dir, ["checkout", "--quiet", "--detach", task.commit]);
  git(dir, ["remote", "remove", "origin"]);
  git(dir, ["update-ref", "--no-deref", "--stdin"], git(dir, ["for-each-ref", "--format=delete %(refname)"]));
  git(dir, ["reflog", "expire", "--expire=now", "--all"]);
  return dir;
};

/** A spend cap stopped the run: later tasks would be rejected too. */
export class BatchStopped extends Error {
  override name = "BatchStopped";
}

export type BatchOptions = {
  readonly tasks: readonly LoadedTask[];
  /** `auto` or `harness/model/effort` for each route to run every task on. */
  readonly routes: readonly string[];
  /** The profile's home: its spend caps apply. */
  readonly home: string;
  /** The run's own Verdandi home, with its own database: browse it with `verdandi start --home <runHome>`. */
  readonly runHome: string;
  readonly harnesses: Partial<Record<HarnessId, HarnessAdapter>>;
  /** Allow what the agent asks to do; otherwise every request is denied, so the run never waits on a person. */
  readonly approve: boolean;
  readonly taskTimeoutMs: number;
  /** Leave each task's copy of the repository behind, to look at. */
  readonly keep: boolean;
  /** Called with each result as it's done. */
  readonly onResult?: (result: BatchResult) => void;
};

/**
 * Runs every task on every route, one at a time, each in a fresh copy of its repository and thread, then grades it
 * by running `verify` on the final tree. Stops early, with what it has, when a spend cap is reached.
 * ponytail: one task at a time. Upgrade: run tasks in parallel once a real eval set's wall time calls for it.
 */
export const runBatch = async (options: BatchOptions): Promise<{ results: BatchResult[]; stopped?: string }> => {
  mkdirSync(options.runHome, { recursive: true });
  // Each copy's task `verify` is its project verifier, so a routed run can escalate, in place of any its policy names, which
  // a batch never trusts. It's handed to the run here, never written into the copy, where the agent could read it.
  const verifyIn = new Map<string, string>();
  const runtime = ManagedRuntime.make(
    AppLayer(options.runHome, options.harnesses, {
      spendCapsHome: options.home,
      verifiers: (projectPath) => {
        const verify = verifyIn.get(projectPath);
        return verify ? [verify] : [];
      },
    }),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, Engine | Reactor | SqlClient.SqlClient>) => runtime.runPromise(effect);
  const dispatch = (command: Parameters<Engine["Service"]["dispatch"]>[0]) =>
    run(Effect.flatMap(Engine, (engine) => engine.dispatch(command)));
  // Nobody is watching a batch: answer each request as it comes, so no turn waits. A repository's own commands never run
  // unasked, so trust requests are denied even with --approve.
  await run(
    Effect.flatMap(Engine, (engine) =>
      engine.react(({ event: e }) => {
        if (
          e.type !== "approval.requested" &&
          e.type !== "user-input.requested" &&
          e.type !== "plan.requested" &&
          e.type !== "skill.proposed" &&
          e.type !== "commands.trust.requested"
        )
          return Effect.void;
        const allow = options.approve && e.type !== "user-input.requested" && e.type !== "commands.trust.requested";
        return engine
          .dispatch({
            type: "approval.respond",
            commandId: randomUUID() as CommandId,
            threadId: e.threadId,
            requestId: e.requestId,
            resolution: allow ? { decision: "allow" } : { decision: "deny" },
          })
          .pipe(Effect.ignore);
      }),
    ),
  );

  const one = async (task: LoadedTask, spec: string): Promise<BatchResult> => {
    const route = parseBatchRoute(spec);
    const started = performance.now();
    const result = (fields: Partial<BatchResult>): BatchResult => ({
      task: task.id,
      route: spec,
      passed: false,
      costUsd: 0,
      meteredUsd: 0,
      turns: 0,
      escalations: 0,
      wallMs: Math.round(performance.now() - started),
      ...fields,
    });
    const dir = checkout(task);
    verifyIn.set(dir, task.verify);
    const threadId = randomUUID() as ThreadId;
    try {
      if (task.setup) {
        const setup = await Effect.runPromise(runVerifier(task.setup, dir));
        if (!setup.passed)
          return result({ error: `setup \`${task.setup}\` failed (exit ${setup.exitCode ?? "none"}): ${setup.output.slice(-500)}` });
      }
      await dispatch({
        type: "thread.create",
        commandId: randomUUID() as CommandId,
        threadId,
        projectPath: dir,
        ...(route !== "auto" && { route }),
      });
      const sent = await dispatch({
        type: "turn.send",
        commandId: randomUUID() as CommandId,
        threadId,
        turnId: randomUUID() as TurnId,
        text: task.prompt,
        mode: task.mode ?? "build",
      }).then(
        () => undefined,
        (e: CommandRejected) => e,
      );
      if (sent?.reason === "SpendCapReached") throw new BatchStopped(sent.message);
      if (sent) return result({ error: sent.message });
      // An escalation's follow-up turn starts from the turn before it, so drain until nothing runs.
      const drained = await run(Effect.flatMap(Reactor, (r) => r.drain).pipe(Effect.timeoutOption(options.taskTimeoutMs)));
      let error: string | undefined;
      if (Option.isNone(drained)) {
        error = `stopped after ${Math.round(options.taskTimeoutMs / 60000)} minutes`;
        const [running] = await run(
          Effect.flatMap(
            SqlClient.SqlClient,
            (sql) => sql<{ id: TurnId }>`select id from turns where thread_id = ${threadId} and status = 'running'`,
          ),
        );
        if (running) await dispatch({ type: "turn.interrupt", commandId: randomUUID() as CommandId, threadId, turnId: running.id });
        await run(Effect.flatMap(Reactor, (r) => r.drain));
      }
      const grade = await Effect.runPromise(runVerifier(task.verify, dir));
      const [stats] = await run(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql<{ cost: number; metered: number; turns: number; escalations: number; ran: string | null }>`
            select
              (select total(u.cost_usd) from usage_ledger u join turns n on n.id = u.turn_id where n.thread_id = ${threadId}) as cost,
              (select total(u.cost_usd) from usage_ledger u join turns n on n.id = u.turn_id
                where n.thread_id = ${threadId} and u.access_mode = 'metered') as metered,
              (select count(*) from turns where thread_id = ${threadId}) as turns,
              (select total(escalations) from tasks where thread_id = ${threadId}) as escalations,
              (select route from tasks where thread_id = ${threadId} order by seq limit 1) as ran`,
        ),
      );
      return result({
        passed: grade.passed,
        costUsd: stats?.cost ?? 0,
        meteredUsd: stats?.metered ?? 0,
        turns: stats?.turns ?? 0,
        escalations: stats?.escalations ?? 0,
        ...(stats?.ran && { ran: JSON.parse(stats.ran) as Route }),
        ...(error && { error }),
      });
    } finally {
      // Done with the thread: its harness session (Claude Code's process, which runs in `dir`) closes before the copy goes.
      await Effect.runPromise(
        Effect.forEach(Object.values(options.harnesses), (harness) => harness?.close(threadId) ?? Effect.void, { discard: true }),
      );
      verifyIn.delete(dir);
      if (!options.keep) rmSync(dir, { recursive: true, force: true });
    }
  };

  const results: BatchResult[] = [];
  try {
    for (const task of options.tasks) {
      for (const spec of options.routes) {
        const r = await one(task, spec);
        results.push(r);
        options.onResult?.(r);
      }
    }
    return { results };
  } catch (e) {
    if (e instanceof BatchStopped) return { results, stopped: e.message };
    throw e;
  } finally {
    await runtime.dispose();
  }
};

/** Per route: how many tasks passed, and what a passed task cost, failed ones' cost included. */
export const summarize = (results: readonly BatchResult[]) =>
  [...Map.groupBy(results, (r) => r.route)].map(([route, rs]) => {
    const passed = rs.filter((r) => r.passed).length;
    const costUsd = rs.reduce((sum, r) => sum + r.costUsd, 0);
    return {
      route,
      tasks: rs.length,
      passed,
      costUsd,
      costPerPassedUsd: passed > 0 ? costUsd / passed : null,
      meanWallMs: rs.reduce((sum, r) => sum + r.wallMs, 0) / rs.length,
      escalations: rs.reduce((sum, r) => sum + r.escalations, 0),
    };
  });

/**
 * What each task would cost on each route, before running anything: the route the router picks (with the repository's
 * policy as checked out now), and its class's rough task size at the target's list prices, mostly cache reads.
 * Subscription targets spend quota instead, priced the same way as the spend dashboard prices them.
 */
export const estimateBatch = async (
  tasks: readonly LoadedTask[],
  routes: readonly string[],
  harnesses: Partial<Record<HarnessId, unknown>>,
) => {
  const routing = routingFor(harnesses);
  const rows: { task: string; route: string; ran?: Route; tokens: number; usd: number | null; error?: string }[] = [];
  for (const task of tasks) {
    const context = await Effect.runPromise(routing(task.repoPath));
    const { answers } = await Effect.runPromise(rulesDecide.decide({ state: task.prompt, questions: taskQuestions(context) }));
    for (const spec of routes) {
      const pin = parseBatchRoute(spec);
      const thread = {
        route: pin === "auto" ? defaultRoute : pin,
        pinned: pin !== "auto",
        budgetMode: null,
        sessionId: null,
        cachedTokens: 0,
      };
      const decided = decideRoute(thread, context, task.prompt, task.mode ?? "build", answers);
      if (Result.isFailure(decided)) {
        rows.push({ task: task.id, route: spec, tokens: 0, usd: null, error: decided.failure.message });
        continue;
      }
      const d = decided.success;
      const tokens = d.estimate?.tokens ?? 0;
      const policy = Result.getOrElse(context.policy, () => context.builtIn);
      const entry = policy.catalog.find((e) => e.harness === d.target.harness && e.model === d.target.model);
      const usd = entry
        ? listCost(entry.price, {
            inputTokens: tokens * 0.15,
            outputTokens: tokens * 0.05,
            cacheReadTokens: tokens * 0.8,
            cacheWriteTokens: 0,
          })
        : null;
      rows.push({ task: task.id, route: spec, ran: { harness: d.target.harness, model: d.target.model, effort: d.effort }, tokens, usd });
    }
  }
  return rows;
};
