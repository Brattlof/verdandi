import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CommandId, type GcReport, GcUnavailable, type ThreadId, type TurnId, type WorktreeView } from "@verdandi/contracts";
import { Context, Effect, Layer, Result, Schedule, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { checkpointRef, threadCheckpoints } from "../checkpoints/checkpoint.ts";
import { refPart } from "../checkpoints/refs.ts";
import { Engine } from "../event-store/engine.ts";
import { git, notARepo } from "../git/git.ts";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * `gc.yaml` in the Verdandi home (ADR 0021): checkpoints older than `keepDays` go, except the last `keepTurns` turns'
 * of each thread that isn't archived, and so do the worktrees of threads archived longer than `keepDays`.
 */
const GcFile = Schema.Struct({ keepDays: Schema.optionalKey(Count), keepTurns: Schema.optionalKey(Count) });
export type GcPolicy = { readonly keepDays: number; readonly keepTurns: number };

export const gcPolicyFile = (home: string) => join(home, "gc.yaml");

/** Read on each sweep, so an edit applies to the next. A missing file means the defaults; a broken one names the file and key. */
export const loadGcPolicy = (home: string): Result.Result<GcPolicy, string> => {
  const file = gcPolicyFile(home);
  if (!existsSync(file)) return Result.succeed({ keepDays: 30, keepTurns: 10 });
  try {
    const data = Schema.decodeUnknownSync(GcFile)(Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}, {
      onExcessProperty: "error",
      errors: "all",
    });
    return Result.succeed({ keepDays: data.keepDays ?? 30, keepTurns: data.keepTurns ?? 10 });
  } catch (e) {
    return Result.fail(
      `${file}: ${e instanceof Error ? e.message : String(e)}\nFix the file (keepDays and keepTurns take whole numbers), or delete it for the defaults.`,
    );
  }
};

const day = 24 * 60 * 60 * 1000;

type Ref = { readonly name: string; readonly oid: string; readonly at: number };

/** The repo's checkpoint and revert refs, with when each was made; none when `cwd` is gone or outside git. */
const verdandiRefs = (cwd: string) =>
  Effect.gen(function* () {
    if (!existsSync(cwd)) return [];
    const out = yield* git(cwd, [
      "for-each-ref",
      "--format=%(refname) %(objectname) %(committerdate:unix)",
      "refs/verdandi/checkpoints/",
      "refs/verdandi/reverts/",
    ]);
    if (out.code !== 0) {
      if (!notARepo(out.stderr))
        yield* Effect.logWarning(`The cleanup sweep skipped ${cwd}: git for-each-ref failed: ${out.stderr.trim()}`);
      return [];
    }
    return out.stdout.split(/\r?\n/).flatMap((line): Ref[] => {
      const [name, oid, at] = line.split(" ");
      return name && oid && at ? [{ name, oid, at: Number(at) * 1000 }] : [];
    });
  }).pipe(Effect.catchTag("GitError", (e) => Effect.as(Effect.logWarning(`The cleanup sweep skipped ${cwd}: ${e.message}`), [])));

/** What a sweep at `now` would remove under `policy`, read from the database and git; changes nothing. */
export const planGc = (policy: GcPolicy, now: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* sql<{
      id: ThreadId;
      path: string;
      archived_at: string | null;
      running: number;
      worktree: string | null;
      saved: string | null;
    }>`
      select t.id, p.path, t.archived_at, t.running_turn_id is not null as running, t.worktree, json_extract(t.revert, '$.saved') as saved
      from threads t join projects p on p.id = t.project_id`;
    const turns = new Map<ThreadId, TurnId[]>();
    for (const t of yield* sql<{ id: TurnId; thread_id: ThreadId }>`select id, thread_id from turns order by started_at, rowid`) {
      const list = turns.get(t.thread_id) ?? [];
      list.push(t.id);
      turns.set(t.thread_id, list);
    }
    const cutoff = now - policy.keepDays * day;

    let count = 0;
    const removed: { threadId: ThreadId; cwd: string; refs: Ref[] }[] = [];
    // Refs live in the repo, which other profiles' threads may share: only this profile's threads' refs are looked at.
    for (const path of new Set(threads.map((t) => t.path))) {
      const ours = new Map(threads.filter((t) => t.path === path).map((t) => [refPart(t.id), t]));
      const byThread = new Map<ThreadId, Ref[]>();
      for (const ref of yield* verdandiRefs(path)) {
        const thread = ours.get(ref.name.split("/")[3] ?? "");
        if (!thread) continue;
        count++;
        const list = byThread.get(thread.id) ?? [];
        list.push(ref);
        byThread.set(thread.id, list);
      }
      for (const [threadId, refs] of byThread) {
        const thread = ours.get(refPart(threadId));
        if (!thread || thread.running) continue;
        // A turn's start and end checkpoints go together, once its newer one is past the cutoff.
        const group = (name: string) => (name.startsWith(threadCheckpoints(threadId)) ? name.slice(0, name.lastIndexOf("/") + 1) : name);
        const newest = new Map<string, number>();
        for (const r of refs) newest.set(group(r.name), Math.max(newest.get(group(r.name)) ?? 0, r.at));
        const ids = turns.get(threadId) ?? [];
        // A thread in use keeps its last turns' checkpoints, its first (the thread's whole diff starts there), and what undoing its revert restores.
        const keep = new Set(
          thread.archived_at === null
            ? [
                ...ids.slice(Math.max(0, ids.length - policy.keepTurns)).map((turnId) => group(checkpointRef(threadId, turnId, "start"))),
                ...(ids[0] ? [checkpointRef(threadId, ids[0], "start")] : []),
                ...(thread.saved ? [thread.saved] : []),
              ]
            : [],
        );
        const old = refs.filter((r) => (newest.get(group(r.name)) ?? 0) < cutoff && !keep.has(r.name) && !keep.has(group(r.name)));
        if (old.length > 0) removed.push({ threadId, cwd: path, refs: old });
      }
    }

    const worktrees: { threadId: ThreadId; root: string; kept?: string }[] = [];
    for (const t of threads) {
      const worktree = t.worktree === null ? undefined : (JSON.parse(t.worktree) as WorktreeView);
      if (t.archived_at === null || Date.parse(t.archived_at) >= cutoff || worktree?.state !== "ready" || !worktree.root) continue;
      const { root } = worktree;
      // `git worktree remove` without --force refuses the same changes; checked first so a kept one records nothing each day.
      const status = existsSync(root) ? yield* git(root, ["status", "--porcelain"]) : undefined;
      const kept =
        status === undefined
          ? undefined
          : status.code !== 0
            ? `git status failed there, so it's kept: ${status.stderr.trim()}`
            : status.stdout.trim()
              ? "It has uncommitted changes or untracked files, so it's kept. Commit or move them and the next sweep removes it, or remove it anyway (Remove anyway in the web UI)."
              : undefined;
      worktrees.push({ threadId: t.id, root, ...(kept && { kept }) });
    }
    return { refs: count, removed, worktrees };
  });

/** Runs the cleanup policy (ADR 0021): verdandid at start and daily, `verdandi gc` on demand. */
export class Gc extends Context.Service<
  Gc,
  { readonly run: (options: { readonly dryRun: boolean; readonly now: number }) => Effect.Effect<GcReport, GcUnavailable> }
>()("verdandi/Gc") {}

/**
 * Removes refs with `git update-ref`, each only if it still points where it did when planned, and records them as
 * `thread.checkpoints.removed`; worktrees go through `thread.worktree.remove`, never forced, queued on their thread.
 */
export const GcLive = (home: string) =>
  Layer.effect(
    Gc,
    Effect.gen(function* () {
      const engine = yield* Engine;
      const sql = yield* SqlClient.SqlClient;
      // One sweep at a time: the daily one and `verdandi gc` would otherwise race to delete the same refs.
      const lock = yield* Semaphore.make(1);
      const run = ({ dryRun, now }: { readonly dryRun: boolean; readonly now: number }) =>
        Effect.gen(function* () {
          const policy = loadGcPolicy(home);
          if (Result.isFailure(policy)) return yield* new GcUnavailable({ reason: "InvalidGcPolicy", message: policy.failure });
          const plan = yield* planGc(policy.success, now).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie);
          const report = (removed: typeof plan.removed, worktrees: typeof plan.worktrees): GcReport => ({
            dryRun,
            refs: plan.refs,
            removed: removed.map((r) => ({ threadId: r.threadId, refs: r.refs.map((ref) => ref.name) })),
            worktrees,
          });
          if (dryRun) return report(plan.removed, plan.worktrees);
          const removed: typeof plan.removed = [];
          for (const r of plan.removed) {
            const out = yield* git(r.cwd, ["update-ref", "--stdin"], {}, r.refs.map((ref) => `delete ${ref.name} ${ref.oid}\n`).join(""));
            if (out.code !== 0) {
              yield* Effect.logWarning(
                `Couldn't remove the checkpoints of thread ${r.threadId}; the next sweep tries again: ${out.stderr.trim()}`,
              );
              continue;
            }
            removed.push(r);
            const refs = r.refs.map((ref) => ref.name);
            yield* engine
              .dispatch({ type: "checkpoints.report", commandId: randomUUID() as CommandId, threadId: r.threadId, refs })
              .pipe(Effect.catchCause((cause) => Effect.logWarning(`Removed ${refs.join(", ")} but couldn't record it.`, cause)));
          }
          const worktrees: typeof plan.worktrees = [];
          for (const w of plan.worktrees) {
            if (w.kept) {
              worktrees.push(w);
              continue;
            }
            const asked = yield* Effect.result(
              engine.dispatch({ type: "thread.worktree.remove", commandId: randomUUID() as CommandId, threadId: w.threadId, force: false }),
            );
            worktrees.push(Result.isFailure(asked) ? { ...w, kept: asked.failure.message } : w);
          }
          return report(removed, worktrees);
        }).pipe(Effect.catchTag("GitError", Effect.die), lock.withPermits(1));
      return Gc.of({ run });
    }),
  );

/** Sweeps when verdandid starts, then once a day. A failure is logged, and the next day's sweep tries again. */
export const GcScheduleLive = Layer.effectDiscard(
  Effect.flatMap(Gc, (gc) =>
    Effect.forkScoped(
      Effect.suspend(() => gc.run({ dryRun: false, now: Date.now() })).pipe(
        Effect.ignoreCause({ log: "Warn", message: "The cleanup sweep failed; the next one tries again." }),
        Effect.repeat(Schedule.spaced("1 day")),
      ),
    ),
  ),
);
