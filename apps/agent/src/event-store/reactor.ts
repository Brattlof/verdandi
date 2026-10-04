import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AttachmentRef,
  Command,
  CommandId,
  DecisionAnswer,
  Effort,
  HarnessAdapter,
  HarnessEvent,
  HarnessId,
  HarnessRunInput,
  InteractionMode,
  Item,
  ProjectId,
  Route,
  StoredEvent,
  TaskId,
  TaskLimits,
  ThreadId,
  TrustPurpose,
  TurnId,
  WorktreeReport,
  WorktreeView,
} from "@verdandi/contracts";
import { trustFiles } from "@verdandi/contracts";
import { Decide, flagged, injectionQuestion, injectionWarning } from "@verdandi/decisions";
import { type Screen, ToolFailed, verdandiTools } from "@verdandi/tools";
import { Cause, Context, Deferred, Effect, Fiber, FiberSet, Layer, Queue, Result, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { loadSmartApprovals, platformShell, rateCommand } from "../approvals/smart-approvals.ts";
import { changedByTurns, changedSince, checkpoint, checkpointRef, restore, revertRef } from "../checkpoints/checkpoint.ts";
import { compressionBlock, compressionPrompt, compressionSummary } from "../compression/compression.ts";
import { editedFiles } from "../diffs/diff.ts";
import { handoffBlock, handoffPrompt, handoffSummary, loadThreadDigest, touchedFiles } from "../handoff/handoff.ts";
import { memoryNudge } from "../memory/memory.ts";
import type { loadMcp } from "../native/mcp-config.ts";
import { loadFreshOutcome, loadTaskDigest, parseReview, reviewPrompt, skillsRefused } from "../review/review.ts";
import { repeatedError } from "../routing/repeated-error.ts";
import { searchSessions } from "../search/search.ts";
import {
  applyChange,
  applyChanges,
  archiveSkill,
  placeSkill,
  prepareChange,
  readableSkills,
  revertStale,
  type SkillFolders,
  viewSkill,
} from "../skills/skill-files.ts";
import { loadInstall } from "../skills/skill-hub.ts";
import { makeSkillProposals } from "../skills/skill-proposals.ts";
import { recordTaskOutcomes, staleOutcomeThreads } from "../tasks/task-outcome.ts";
import { recordTrajectory, unrecordedTurns } from "../tasks/trajectory.ts";
import { contextList, flaggedFiles, sha256 } from "../trust/context.ts";
import { isTrusted } from "../trust/trust.ts";
import { runVerifier } from "../verifiers/verify.ts";
import { addWorktree, loadThreadFolder, removeWorktree, threadFolder, worktreeSetup } from "../worktrees/worktree.ts";
import type { AuxStarted } from "./decider.ts";
import { Engine } from "./engine.ts";
import { loadMemory } from "./projector.ts";

export class HarnessRegistry extends Context.Service<HarnessRegistry, Partial<Record<HarnessId, HarnessAdapter>>>()(
  "verdandi/HarnessRegistry",
) {}

/**
 * How Verdandi's tools behave in this profile (`memory.yaml`): whether the user approves each memory save, and every
 * how many turns of a thread the turn nudges the agent to save memory (0 never).
 */
export class ToolSettings extends Context.Service<
  ToolSettings,
  { readonly approveMemorySaves: boolean; readonly memoryNudgeEvery: number }
>()("verdandi/ToolSettings") {}

/** Background review in this profile (`review.yaml`, DESIGN §14.5): whether it runs, and whether it may spend metered dollars. */
export class ReviewSettings extends Context.Service<ReviewSettings, { readonly enabled: boolean; readonly allowMetered: boolean }>()(
  "verdandi/ReviewSettings",
) {}

/** Smart approvals in this profile (`approvals.yaml`, DESIGN §17): whether they're enabled, which the user can then turn off. */
export class ApprovalSettings extends Context.Service<ApprovalSettings, { readonly smart: boolean }>()("verdandi/ApprovalSettings") {}

/** The profile's skills folder, which approved skill proposals are written to, and the read-only extra folders (DESIGN §14.4). */
export class ProfileSkills extends Context.Service<ProfileSkills, SkillFolders>()("verdandi/ProfileSkills") {}

/** Where the profile keeps threads' git worktrees, as `<repo>/<branch>` (DESIGN §13). */
export class WorktreesDir extends Context.Service<WorktreesDir, string>()("verdandi/WorktreesDir") {}

/** The MCP servers a native session in a folder connects to (`loadMcp` for the profile's home), read when it opens. */
export class McpConfig extends Context.Service<McpConfig, (folder: string) => ReturnType<typeof loadMcp>>()("verdandi/McpConfig") {}

/** Where the profile keeps attachments' bytes, which harness turns read by path. */
export class AttachmentsDir extends Context.Service<AttachmentsDir, string>()("verdandi/AttachmentsDir") {}

/**
 * The project's verifiers and how many times the same tool error repeats before it escalates its task
 * (`escalation.verifiers` and `escalation.repeatedErrors` in its routing policy), and its `delegation` limits for the
 * native agent's subtasks (DESIGN §9.4), read when a turn needs them. `fromProject`: the verifiers come from the
 * project's own policy file, so they run only once the user trusts them; false for those Verdandi's caller supplied (a
 * batch task's `verify`).
 */
export class ProjectEscalation extends Context.Service<
  ProjectEscalation,
  (projectPath: string) => Effect.Effect<{
    readonly verifiers: readonly string[];
    readonly fromProject: boolean;
    readonly repeatedErrors: number;
    readonly delegation: { readonly maxConcurrent: number; readonly maxDepth: number };
  }>
>()("verdandi/ProjectEscalation") {}

export class Reactor extends Context.Service<
  Reactor,
  {
    /** Completes when no turn is running. Tests wait on this instead of sleeping. */
    readonly drain: Effect.Effect<void>;
  }
>()("verdandi/Reactor") {}

/** `{ memory }`: the memory snapshot taken for turn `turnId`, when that turn starts a session; else nothing. */
const memoryFor = (stored: string | null, turnId: TurnId) => {
  const snapshot = stored === null ? undefined : (JSON.parse(stored) as { turnId: TurnId; text: string });
  return snapshot?.turnId === turnId ? { memory: snapshot.text } : {};
};
/** The Verdandi tools a confined thread keeps: none that reaches the owner's memory, sessions or skills. */
const confinedTools = new Set(["report_blocked"]);
/** How long a turn waits for a handoff's or a compression's summary before it goes on without one. */
/** How long a turn waits for its handoff summary before it starts without one. */
const auxTimeout = "5 minutes";

const errorMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  if (error._tag === "Some" && typeof error.value === "object" && error.value !== null && "message" in error.value) {
    return String(error.value.message);
  }
  return `Verdandi hit an internal error while running this turn. Details: ${Cause.pretty(cause)}`;
};

/**
 * Runs harness turns as side effects of `turn.started`, feeds them `turn.steered` messages, moves a
 * running turn to an approved plan's build route, passes `approval.resolved` answers back to the harness, stops turns the user interrupted, records each
 * completed turn's trajectory and its task's outcome, and recovers turns a previous run left behind.
 */
export const ReactorLive = Layer.effect(
  Reactor,
  Effect.gen(function* () {
    const engine = yield* Engine;
    const registry = yield* HarnessRegistry;
    const attachmentsDir = yield* AttachmentsDir;
    const worktreesDir = yield* WorktreesDir;
    const toolSettings = yield* ToolSettings;
    const projectEscalation = yield* ProjectEscalation;
    const decide = yield* Decide;
    const skillFolders = yield* ProfileSkills;
    const reviews = yield* ReviewSettings;
    const mcpConfig = yield* McpConfig;
    const approvals = yield* ApprovalSettings;
    const sql = yield* SqlClient.SqlClient;
    const turns = yield* FiberSet.make();
    /** The adapter running each thread's current turn: where answers to its requests go. */
    const live = new Map<ThreadId, HarnessAdapter>();
    // ponytail: a steer accepted in the moment between the harness finishing and verifiers.started or turn.completed
    // committing is recorded but never delivered, since its turn is over. Upgrade: have the harness report delivery.
    const steerQueues = new Map<TurnId, Queue.Queue<string>>();
    /**
     * Each thread's latest work: a turn, or adding or removing its worktree. An interrupt of the turn stops it,
     * and the thread's next work waits for it to wind down.
     */
    const latest = new Map<ThreadId, { readonly key: object; readonly turnId?: TurnId; readonly fiber: Fiber.Fiber<void> }>();
    /** Trust requests waiting for the user, by request id (the request's command id): true once allowed. */
    const trustAnswers = new Map<string, Deferred.Deferred<boolean>>();
    /** Handoff and compression threads whose one turn a waiting turn needs: its reply once it completes, undefined when it failed. */
    const auxReplies = new Map<ThreadId, Deferred.Deferred<string | undefined>>();

    /** The main agent's last reply in turn `turnId`, or undefined when it gave none. */
    const lastReply = (turnId: TurnId) =>
      Effect.map(
        sql<{ text: string }>`
          select json_extract(payload, '$.text') as text from items
          where turn_id = ${turnId} and json_extract(payload, '$.kind') = 'assistant.message'
            and json_extract(payload, '$.parentToolUseId') is null
          order by idx desc limit 1`,
        ([reply]) => reply?.text,
      );

    /** Runs `work` once everything queued for the thread before it has finished, finalizers included. */
    const enqueue = (threadId: ThreadId, work: Effect.Effect<void>, turnId?: TurnId) =>
      Effect.gen(function* () {
        const key = {};
        const previous = latest.get(threadId)?.fiber;
        const fiber = yield* FiberSet.run(
          turns,
          Effect.andThen(previous ? Fiber.await(previous) : Effect.void, work).pipe(
            Effect.ensuring(Effect.sync(() => latest.get(threadId)?.key === key && latest.delete(threadId))),
          ),
        );
        latest.set(threadId, { key, fiber, ...(turnId && { turnId }) });
      });

    const report = (threadId: ThreadId, turnId: TurnId, event: HarnessEvent) =>
      engine.dispatch({ type: "harness.report", commandId: randomUUID() as CommandId, threadId, turnId, event });

    const skills = makeSkillProposals(engine.dispatch, skillFolders, sql);
    /** Scans untrusted text a tool hands the agent: a flagged one still reaches it, under the warning; recording it is best effort. */
    const screen: Screen = (source, text, at) =>
      Effect.gen(function* () {
        const [answer] = (yield* decide.decide({ state: text, questions: [injectionQuestion] })).answers;
        if (!answer || !flagged(answer)) return text;
        yield* engine
          .dispatch({ type: "injection.flag", commandId: randomUUID() as CommandId, ...at, source, text, answer })
          .pipe(Effect.catchCause((cause) => Effect.logWarning(`Could not record the injection flag on turn ${at.turnId}.`, cause)));
        return `${injectionWarning}\n\n${text}`;
      });
    /** Verdandi's own tools (DESIGN §9.6), built once: every turn gets this same list, so a session's never changes. */
    const tools = verdandiTools({
      search: (query, allProjects, at) =>
        Effect.gen(function* () {
          const [thread] = yield* sql<{ project_id: ProjectId }>`select project_id from threads where id = ${at.threadId}`;
          return yield* searchSessions({ query, ...(!allProjects && thread && { projectId: thread.project_id }) });
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
      block: (reason, at) =>
        engine.dispatch({ type: "task.block", commandId: randomUUID() as CommandId, ...at, reason }).pipe(
          Effect.asVoid,
          Effect.catchTag("CommandRejected", (e) => Effect.fail(new ToolFailed({ message: e.message }))),
          // Only a database failure is a defect; a refusal goes back to the agent as the tool's error.
          Effect.catchTag("SqlError", Effect.die),
        ),
      memory: {
        save: (scope, text, replaces, at) => {
          const commandId = randomUUID() as CommandId;
          return engine.dispatch({ type: "memory.save", commandId, ...at, scope, text, replaces }).pipe(
            Effect.andThen(
              sql<{ n: number }>`select count(*) as n from events where command_id = ${commandId} and type = 'memory.proposed'`,
            ),
            Effect.map(([proposed]) => (proposed?.n ? ("proposed" as const) : ("saved" as const))),
            Effect.catchTag("CommandRejected", (e) => Effect.fail(new ToolFailed({ message: e.message }))),
            Effect.catchTag("SqlError", Effect.die),
          );
        },
        entries: (at) =>
          loadMemory(at.threadId).pipe(
            Effect.map((m) => (m ? [...m.user, ...m.project] : [])),
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.orDie,
          ),
      },
      approveMemorySaves: toolSettings.approveMemorySaves,
      screen,
      proposeSkill: skills.propose,
      skills: {
        list: () => Effect.sync(() => readableSkills(skillFolders).map(({ name, description }) => ({ name, description }))),
        view: (name, path) =>
          Effect.suspend(() => {
            const viewed = viewSkill(skillFolders, name, path);
            return "error" in viewed ? Effect.fail(new ToolFailed({ message: viewed.error })) : Effect.succeed(viewed.text);
          }),
      },
    });

    /** The injection question's answer per text, by its hash: a context file is scanned once per content (DESIGN §17). */
    const scanned = new Map<string, DecisionAnswer | undefined>();
    const scanText = (text: string) =>
      Effect.gen(function* () {
        const key = sha256(text);
        if (scanned.has(key)) return scanned.get(key);
        const [answer] = (yield* decide.decide({ state: text, questions: [injectionQuestion] })).answers;
        // ponytail: forgets the oldest past 1,000 texts. Upgrade: an LRU, if a long-running verdandid rescans often.
        if (scanned.size >= 1000) scanned.delete(scanned.keys().next().value ?? "");
        scanned.set(key, answer);
        return answer;
      });
    /** Records a flagged context `file` on the turn; best effort, as the turn goes on either way. */
    const flagContext = (
      at: { threadId: ThreadId; turnId: TurnId },
      file: string,
      text: string,
      answer: DecisionAnswer,
      withheld: boolean,
    ) =>
      engine
        .dispatch({
          type: "injection.flag",
          commandId: randomUUID() as CommandId,
          ...at,
          source: "context",
          text,
          answer,
          file,
          ...(withheld && { withheld: true }),
        })
        .pipe(Effect.catchCause((cause) => Effect.logWarning(`Could not record the injection flag on turn ${at.turnId}.`, cause)));
    /**
     * `scan` for a harness that puts context files in front of the agent itself (native, DESIGN §17): whether `text` from
     * `file` is flagged, recorded on the turn as left out.
     */
    const scanFor = (at: { threadId: ThreadId; turnId: TurnId }) => (file: string, text: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const answer = yield* scanText(text);
          if (!answer || !flagged(answer)) return false;
          yield* flagContext(at, file, text, answer, true);
          return true;
        }),
      );

    /**
     * Smart approvals for turn `turnId` (DESIGN §17): rates each terminal command its agent wants to run, recording the
     * guard's answer, or answers undefined while the user has them turned off, read at each command so a click applies at once.
     */
    const guardFor =
      (threadId: ThreadId, turnId: TurnId): NonNullable<HarnessRunInput["guard"]> =>
      (command) =>
        Effect.runPromise(
          Effect.gen(function* () {
            if (!(yield* loadSmartApprovals(approvals.smart)).on) return undefined;
            return yield* rateCommand(command, platformShell, decide, (state, answer) =>
              engine
                .dispatch({ type: "approval.guard", commandId: randomUUID() as CommandId, threadId, turnId, state, answer })
                .pipe(Effect.catchCause((cause) => Effect.logWarning(`Could not record the guard's verdict on turn ${turnId}.`, cause))),
            );
          }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catchCause((cause) =>
              Effect.as(Effect.logWarning(`Smart approvals failed on turn ${turnId}.`, cause), {
                verdict: "ask" as const,
                reason: "smart approvals failed",
              }),
            ),
          ),
        );

    /**
     * Delegation for the native agent of turn `turnId` (DESIGN §9.4): `task.delegate` routes each subtask as a task of its
     * own and records it on the turn, or is rejected, and its message goes back to the agent.
     */
    const delegateFor = (
      threadId: ThreadId,
      turnId: TurnId,
      limits: { readonly maxConcurrent: number; readonly maxDepth: number },
    ): NonNullable<HarnessRunInput["delegate"]> => ({
      ...limits,
      route: ({ toolUseId, task, profile }) => {
        const commandId = randomUUID() as CommandId;
        return Effect.runPromise(
          engine.dispatch({ type: "task.delegate", commandId, threadId, turnId, toolUseId, task, ...(profile && { profile }) }).pipe(
            Effect.andThen(sql<{ moved: string }>`
              select json_extract(payload, '$.to') as moved from events where command_id = ${commandId} and type = 'task.delegated'`),
            Effect.map(([row]) =>
              row ? { route: JSON.parse(row.moved) as Route } : { error: "Verdandi recorded no route for the subtask." },
            ),
            Effect.catchTag("CommandRejected", (e) => Effect.succeed({ error: e.message })),
            Effect.catchCause((cause) =>
              Effect.as(Effect.logWarning(`Could not route a subtask of turn ${turnId}.`, cause), {
                error: "Verdandi couldn't route the subtask because of an internal error.",
              }),
            ),
          ),
        );
      },
    });

    // A failed write is retried by the sweep below when verdandid next starts.
    const record = (threadId: ThreadId, turnId: TurnId) =>
      recordTrajectory(threadId, turnId).pipe(
        Effect.catchCause((cause) => Effect.logWarning(`Could not record the trajectory of turn ${turnId}.`, cause)),
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    const recordOutcomes = (threadId: ThreadId) =>
      recordTaskOutcomes(threadId).pipe(
        Effect.catchCause((cause) => Effect.logWarning(`Could not record the task outcomes of thread ${threadId}.`, cause)),
        Effect.provideService(SqlClient.SqlClient, sql),
      );

    /**
     * Asks whether the turns of task `taskId` up to `turnId`, since the thread's last review, are worth a background
     * review (DESIGN §14.5); the decider logs the answer and, on a yes, records `review.requested`.
     */
    const askReview = (threadId: ThreadId, turnId: TurnId, taskId: TaskId) =>
      Effect.gen(function* () {
        // A confined thread's text comes from someone other than the owner: no unconfined review reads it (ADR 0036).
        const [confined] = yield* sql<{ confined: number }>`select confined from threads where id = ${threadId}`;
        if (confined?.confined === 1) return;
        const digest = yield* loadTaskDigest(threadId, taskId, turnId);
        if (!digest) return;
        const reviewThreadId = randomUUID() as ThreadId;
        yield* engine.dispatch({
          type: "task.review",
          commandId: randomUUID() as CommandId,
          threadId,
          taskId,
          turnId,
          reviewThreadId,
          digest,
        });
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchCause((cause) => Effect.logWarning(`Could not ask whether turn ${turnId} is worth a review.`, cause)),
      );

    /**
     * Starts a requested review: its own thread in the project, hidden from thread lists, and the one turn it sends,
     * routed as an `aux.review` task. Spend caps, quota and review.yaml can refuse that turn, which ends the review.
     */
    // ponytail: a review requested just before verdandid stops never starts, and its turns aren't asked about again.
    // Upgrade: on startup, start each `review.requested` that has no `review.started`, if lost reviews turn out to matter.
    const startReview = (e: Extract<StoredEvent["event"], { type: "review.requested" }>) =>
      Effect.gen(function* () {
        yield* engine.dispatch({
          type: "review.start",
          commandId: randomUUID() as CommandId,
          threadId: e.reviewThreadId,
          projectPath: e.projectPath,
          reviews: { threadId: e.threadId, taskId: e.taskId, turnId: e.turnId },
          allowMetered: reviews.allowMetered,
        });
        yield* engine.dispatch({
          type: "turn.send",
          commandId: randomUUID() as CommandId,
          threadId: e.reviewThreadId,
          turnId: randomUUID() as TurnId,
          text: reviewPrompt(e.digest),
          mode: "ask",
        });
      }).pipe(
        Effect.catchTag("CommandRejected", (rejected) => Effect.logInfo(rejected.message)),
        Effect.catchCause((cause) => Effect.logWarning(`Could not start the review of turn ${e.turnId}.`, cause)),
      );

    /**
     * Turns a finished review's reply into proposals on the reviewed thread, after its turn `of.turnId`: each one scanned
     * by the decider and left for the user. The reply is untrusted data; one that can't be read proposes nothing. Its
     * skills are dropped unless something backed the reviewed task (`skillsRefused`).
     */
    const settleReview = (
      turnId: TurnId,
      reviewThreadId: ThreadId,
      { taskId, ...of }: { readonly threadId: ThreadId; readonly taskId: TaskId; readonly turnId: TurnId },
    ) =>
      Effect.gen(function* () {
        const parsed = parseReview((yield* lastReply(turnId)) ?? "");
        if ("error" in parsed) return yield* Effect.logWarning(`Review ${reviewThreadId}: ${parsed.error}`);
        const propose = (proposal: Extract<Command, { type: "review.propose" }>["proposal"]) =>
          engine
            .dispatch({ type: "review.propose", commandId: randomUUID() as CommandId, ...of, reviewThreadId, proposal })
            .pipe(Effect.catchTag("CommandRejected", (rejected) => Effect.logInfo(`Review ${reviewThreadId}: ${rejected.message}`)));
        yield* Effect.forEach(parsed.memories, (m) => propose({ kind: "memory", ...m }), { discard: true });
        if (parsed.skills.length === 0) return;
        const refused = skillsRefused(yield* loadFreshOutcome(of.threadId, taskId).pipe(Effect.provideService(SqlClient.SqlClient, sql)));
        if (refused)
          return yield* Effect.logInfo(
            `Review ${reviewThreadId}: dropped ${parsed.skills.length} skill proposal(s), since ${refused}: ${parsed.skills.map((s) => s.skill).join(", ")}.`,
          );
        // A skill change carries the file as it is now, read here like `skill_manage`'s.
        yield* Effect.forEach(
          parsed.skills,
          (edit) => {
            const prepared = Result.try(() => prepareChange(skillFolders, edit));
            if (Result.isFailure(prepared))
              return Effect.logInfo(`Review ${reviewThreadId}: couldn't read the skill ${edit.skill}: ${String(prepared.failure)}`);
            if ("error" in prepared.success) return Effect.logInfo(`Review ${reviewThreadId}: ${prepared.success.error}`);
            return propose({ kind: "skill", change: prepared.success.change });
          },
          { discard: true },
        );
      }).pipe(Effect.catchCause((cause) => Effect.logWarning(`Could not record what review ${reviewThreadId} proposed.`, cause)));

    /**
     * Whether the project's own `commands` may run for running turn `turnId` (DESIGN §17): yes once the user trusts that
     * exact list in the project, else Verdandi asks on the turn and waits. A list the agent rewrote asks again; a turn
     * that ends first runs nothing.
     */
    const trusted = (threadId: ThreadId, turnId: TurnId, purpose: TrustPurpose, commands: readonly string[]) =>
      Effect.gen(function* () {
        if (yield* isTrusted(threadId, commands).pipe(Effect.provideService(SqlClient.SqlClient, sql))) return true;
        const commandId = randomUUID() as CommandId;
        const answer = yield* Deferred.make<boolean>();
        // Registered before the request commits, so an answer can never arrive first.
        trustAnswers.set(commandId, answer);
        return yield* engine.dispatch({ type: "commands.trust.request", commandId, threadId, turnId, purpose, commands }).pipe(
          Effect.andThen(Deferred.await(answer)),
          Effect.catchTag("CommandRejected", () => Effect.succeed(false)),
          Effect.ensuring(Effect.sync(() => trustAnswers.delete(commandId))),
        );
      });

    /**
     * Whether turn `turnId` may start `adapter` in `cwd` (DESIGN §17): yes when the injection scan flags none of the
     * files it loads by itself, or the user trusts those exact files' contents in the project. Else each flagged file is
     * recorded on the turn and Verdandi asks, since the harness can't leave one out; a turn that ends first starts nothing.
     * An `unattended` turn (a background review) has nobody to ask, so it doesn't start.
     */
    const contextAllowed = (threadId: ThreadId, turnId: TurnId, adapter: HarnessAdapter, cwd: string, unattended: boolean) =>
      Effect.gen(function* () {
        const hits = yield* flaggedFiles(adapter.loads?.(cwd) ?? [], cwd, scanText);
        if (hits.length === 0) return { allowed: true, files: [] };
        const list = contextList(hits);
        const files = hits.map((h) => h.file);
        if (yield* isTrusted(threadId, list).pipe(Effect.provideService(SqlClient.SqlClient, sql))) return { allowed: true, files };
        yield* Effect.forEach(hits, (h) => flagContext({ threadId, turnId }, h.file, h.text, h.answer, false), { discard: true });
        return { allowed: !unattended && (yield* trusted(threadId, turnId, "context", list)), files };
      });

    /**
     * The MCP servers a native session of turn `turnId` connects to in `cwd` (DESIGN §9.4), read when it opens: the
     * project's own start only once the user trusts that exact list, else they're left out with a notice. A broken config
     * rejects, naming the file and key.
     */
    const mcpFor = (threadId: ThreadId, turnId: TurnId, cwd: string) => async () => {
      const loaded = mcpConfig(cwd);
      if (loaded.trust.length === 0 || (await Effect.runPromise(trusted(threadId, turnId, "mcp", loaded.trust))))
        return { servers: loaded.servers, notices: loaded.notices };
      return {
        servers: loaded.servers.filter((s) => !loaded.project.includes(s.name)),
        notices: [
          ...loaded.notices,
          `Verdandi didn't start this project's MCP servers (${loaded.project.join(", ")}, from ${trustFiles.mcp}): they weren't allowed. This session has none of their tools; a new thread asks again.`,
        ],
      };
    };

    /** How a list of commands reads in a notice: each in backticks. */
    const listed = (commands: readonly string[]) => commands.map((c) => `\`${c}\``).join(", ");

    /**
     * Runs the project's verifiers in order until one fails, recording each on the turn before it completes (DESIGN §8.7).
     * Returns the run that failed, if one did.
     */
    const verify = (threadId: ThreadId, turnId: TurnId, projectPath: string, cwd: string) =>
      Effect.gen(function* () {
        const { verifiers: commands, fromProject } = yield* projectEscalation(projectPath);
        if (commands.length === 0) return undefined;
        // Before the first runs, so the decider refuses a steer the finished agent would never read.
        yield* engine.dispatch({ type: "verifiers.start", commandId: randomUUID() as CommandId, threadId, turnId });
        if (fromProject && !(yield* trusted(threadId, turnId, "verifiers", commands))) {
          const text = `Verdandi didn't run this project's verifiers (${listed(commands)} from ${trustFiles.verifiers}): they weren't allowed to run. The task records no verifier run, and the next turn that changes files asks again.`;
          yield* report(threadId, turnId, { type: "item", item: { kind: "notice", text } });
          return undefined;
        }
        for (const command of commands) {
          const run = yield* runVerifier(command, cwd);
          yield* engine.dispatch({ type: "verifier.report", commandId: randomUUID() as CommandId, threadId, turnId, run });
          if (!run.passed) return run;
        }
        return undefined;
      });

    /**
     * The tool error that came back the project's `escalation.repeatedErrors` times in the thread's task since it last
     * escalated, across its turns, as an escalation trigger (DESIGN §8.7); undefined when none did.
     */
    const repeatedErrorIn = (threadId: ThreadId, projectPath: string) =>
      Effect.gen(function* () {
        const { repeatedErrors } = yield* projectEscalation(projectPath);
        if (repeatedErrors === 0) return undefined;
        const errors = yield* sql<{ tool: string; error: string }>`
          select json_extract(c.payload, '$.name') as tool, json_extract(r.payload, '$.content') as error
          from threads t join tasks k on k.id = t.task_id
            join turns n on n.thread_id = t.id and n.started_at >= k.started_at and n.reverted = 0
            join items r on r.turn_id = n.id and json_extract(r.payload, '$.kind') = 'tool.result' and json_extract(r.payload, '$.isError')
            join items c on c.turn_id = n.id and json_extract(c.payload, '$.kind') = 'tool.call'
              and json_extract(c.payload, '$.toolUseId') = json_extract(r.payload, '$.toolUseId')
          where t.id = ${threadId} and n.rowid > coalesce((
            select max(u.rowid) from events e join turns u on u.id = json_extract(e.payload, '$.turnId')
            where e.thread_id = t.id and e.type = 'task.escalated' and json_extract(e.payload, '$.taskId') = k.id), 0)
          order by n.rowid, r.idx`;
        return repeatedError(errors, repeatedErrors);
      });

    /** Saves the thread's tree as turn `turnId`'s start or end checkpoint (DESIGN §13). A failure is logged, never the turn's. */
    const saveCheckpoint = (threadId: ThreadId, turnId: TurnId, at: "start" | "end") =>
      Effect.gen(function* () {
        const [thread] = yield* sql<{ path: string; worktree: string | null; review: string | null }>`
          select p.path, t.worktree, t.review from threads t join projects p on p.id = t.project_id where t.id = ${threadId}`;
        const cwd = thread && threadFolder(thread.path, thread.worktree);
        // A folder outside git has no checkpoints, and `checkpoint` skips it. A review or a handoff only reads the project.
        if (cwd && existsSync(cwd) && thread.review === null) yield* checkpoint(cwd, checkpointRef(threadId, turnId, at));
      }).pipe(Effect.catchCause((cause) => Effect.logWarning(`Could not save the ${at} checkpoint of turn ${turnId}.`, cause)));

    /**
     * Whether turn `turnId` changed the files under `cwd`, by any means: its start checkpoint against the tree now, the
     * same for every harness. Outside git, or without a start checkpoint, the turn's file-tool calls say.
     */
    const changedFiles = (threadId: ThreadId, turnId: TurnId, cwd: string, calls: readonly Item[]) =>
      changedSince(cwd, checkpointRef(threadId, turnId, "start")).pipe(
        Effect.catchCause((cause) =>
          Effect.as(Effect.logWarning(`Could not compare turn ${turnId}'s files with its start checkpoint.`, cause), undefined),
        ),
        Effect.map((changed) => changed ?? editedFiles(cwd, calls).inside.length > 0),
      );

    /**
     * The summary that turn `turnId`'s new session on `to` starts from, the thread having last run on `from` (DESIGN
     * §8.2 lever 5): written by the one turn of a hidden handoff thread, an `aux.handoff` task routed like a review
     * (spend caps, quota), over a digest of the thread; Files touched comes from its checkpoints. The summary is
     * recorded on the turn as a `handoff` item and scanned like any untrusted text Verdandi hands the agent. Undefined,
     * with a `notice` on the turn saying why, when it can't be written: the turn goes on without it.
     */
    const handOff = (threadId: ThreadId, turnId: TurnId, from: HarnessId, to: HarnessId, projectPath: string, cwd: string) => {
      const without = (why: string) =>
        Effect.as(
          report(threadId, turnId, {
            type: "item",
            item: {
              kind: "notice",
              text: `Verdandi couldn't write a summary of this thread for its new ${to} session (${why}), so the agent starts without what came before. It can look back with session_search.`,
            },
          }),
          undefined,
        );
      return Effect.gen(function* () {
        const { digest, turnIds } = yield* loadThreadDigest(threadId, turnId);
        if (!digest) return undefined;
        const files = yield* touchedFiles(cwd, threadId, turnIds);
        const got = yield* auxReply(
          {
            type: "handoff.start",
            commandId: randomUUID() as CommandId,
            threadId: randomUUID() as ThreadId,
            projectPath,
            for: { threadId, turnId },
            from,
            to,
          },
          handoffPrompt(digest, from, to),
        );
        if ("error" in got) return yield* without(got.error);
        const summary = handoffSummary(got.reply, files);
        const scan = yield* scanHanded(threadId, turnId, "handoff", summary);
        yield* report(threadId, turnId, { type: "item", item: { kind: "handoff", from, to, summary } });
        return handoffBlock(summary, from, to, scan);
      }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.andThen(Effect.logWarning(`Could not hand thread ${threadId} off.`, cause), without("an internal error")),
        ),
      );
    };

    /**
     * Runs Verdandi's own one-turn task `start` (a handoff's or a compression's hidden thread) with `prompt`, routed in
     * its `aux.*` class like a review (spend caps, quota): its reply and turn once it completes, or why there's none.
     */
    const auxReply = (start: Extract<Command, { type: "handoff.start" | "compression.start" }>, prompt: string) => {
      type AuxReply = { readonly error: string } | { readonly reply: string; readonly turnId: TurnId };
      const failed = (error: string): AuxReply => ({ error });
      const auxTurnId = randomUUID() as TurnId;
      return Effect.gen(function* () {
        // Registered before the turn is sent, so its completion can never come first.
        const replied = yield* Deferred.make<string | undefined>();
        auxReplies.set(start.threadId, replied);
        const sent = yield* Effect.result(
          Effect.andThen(
            engine.dispatch(start),
            engine.dispatch({
              type: "turn.send",
              commandId: randomUUID() as CommandId,
              threadId: start.threadId,
              turnId: auxTurnId,
              text: prompt,
              mode: "ask",
            }),
          ).pipe(Effect.catchTag("SqlError", Effect.die)),
        );
        if (Result.isFailure(sent)) return failed(sent.failure.message.replace(/\.$/, ""));
        // ponytail: an interrupt of the waiting turn leaves the aux turn running to its end, unread; its route's maxCost
        // bounds it. Upgrade: interrupt it too, if abandoned handoffs or compressions show up in the spend.
        const reply = yield* Deferred.await(replied).pipe(Effect.timeoutOption(auxTimeout));
        if (reply._tag === "None") return failed("its turn took longer than 5 minutes");
        if (!reply.value?.trim()) return failed("its turn ended without a summary");
        const done: AuxReply = { reply: reply.value, turnId: auxTurnId };
        return done;
      }).pipe(Effect.ensuring(Effect.sync(() => auxReplies.delete(start.threadId))));
    };

    /**
     * Scans `text` Verdandi is about to hand turn `turnId`'s agent from `source`, recording a hit as `injection.flagged`
     * (DESIGN §17): the scan's answer, for the fence's warning.
     */
    const scanHanded = (threadId: ThreadId, turnId: TurnId, source: "handoff" | "compression", text: string) =>
      Effect.gen(function* () {
        const [scan] = (yield* decide.decide({ state: text, questions: [injectionQuestion] })).answers;
        if (scan && flagged(scan))
          yield* engine
            .dispatch({ type: "injection.flag", commandId: randomUUID() as CommandId, threadId, turnId, source, text, answer: scan })
            .pipe(Effect.catchCause((cause) => Effect.logWarning(`Could not record the injection flag on turn ${turnId}.`, cause)));
        return scan;
      });

    /**
     * The native harness's `summarize` for turn `turnId` (DESIGN §16): background review first, when review.yaml turns it
     * on, over the task's turns so far, so what's worth remembering is saved before the conversation is summarized; then
     * the one turn of a hidden compression thread, an `aux.compress` task, writes the sections. Files touched comes from
     * the checkpoints of the turns being summarized. Fails closed: a reply missing a section is refused.
     */
    const summarizeFor =
      (
        threadId: ThreadId,
        turnId: TurnId,
        taskId: TaskId | null,
        projectPath: string,
        cwd: string,
      ): NonNullable<HarnessRunInput["summarize"]> =>
      ({ digest, previous, turnIds }) =>
        Effect.runPromise(
          Effect.gen(function* () {
            if (reviews.enabled && taskId) yield* askReview(threadId, turnId, taskId);
            const got = yield* auxReply(
              {
                type: "compression.start",
                commandId: randomUUID() as CommandId,
                threadId: randomUUID() as ThreadId,
                projectPath,
                for: { threadId, turnId },
              },
              compressionPrompt(digest, previous),
            );
            if ("error" in got) return got;
            const summary = compressionSummary(got.reply, yield* touchedFiles(cwd, threadId, turnIds));
            if ("error" in summary) return summary;
            const scan = yield* scanHanded(threadId, turnId, "compression", summary.sections);
            const [spent] = yield* sql<{ usd: number }>`select total(cost_usd) as usd from usage_ledger where turn_id = ${got.turnId}`;
            return { sections: summary.sections, block: compressionBlock(summary.sections, scan), costUsd: spent?.usd ?? 0 };
          }).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catchCause((cause) =>
              Effect.as(Effect.logWarning(`Could not summarize turn ${turnId}'s session.`, cause), { error: "an internal error" }),
            ),
          ),
        );

    const runTurn = (
      threadId: ThreadId,
      turnId: TurnId,
      text: string,
      mode: InteractionMode,
      attachments: readonly AttachmentRef[],
      steers: Stream.Stream<string>,
    ) => {
      let finished = false;
      const fail = (error: string) => report(threadId, turnId, { type: "turn.finished", status: "error", error });
      return Effect.gen(function* () {
        // The task's budget guards, and what its turns before this one cost and how many model calls they made.
        const [thread] = yield* sql<{
          route: string;
          session_id: string | null;
          path: string;
          worktree: string | null;
          pending_fork: string | null;
          memory_snapshot: string | null;
          transcript_path: string | null;
          task_id: TaskId | null;
          limits: string | null;
          spent_usd: number;
          spent_turns: number;
          turn_number: number;
          review: string | null;
          session_harness: HarnessId | null;
          confined: number;
        }>`
          select t.route, t.session_id, t.session_harness, t.confined, p.path, t.worktree, t.review, t.pending_fork, t.memory_snapshot, t.transcript_path, t.task_id, json_extract(d.payload, '$.limits') as limits,
            (select total(u.cost_usd) from usage_ledger u join turns n on n.id = u.turn_id
              where n.thread_id = t.id and n.started_at >= k.started_at and n.id != ${turnId}) as spent_usd,
            (select count(*) from events e where e.thread_id = t.id and e.type = 'turn.model.called'
              and json_extract(e.payload, '$.turnId') in (select n.id from turns n
                where n.thread_id = t.id and n.started_at >= k.started_at and n.id != ${turnId})) as spent_turns,
            (select count(*) from turns n where n.thread_id = t.id and n.rowid <= (select rowid from turns where id = ${turnId})) as turn_number
          from threads t join projects p on p.id = t.project_id
            left join tasks k on k.id = t.task_id left join route_decisions d on d.task_id = t.task_id
          where t.id = ${threadId}`;
        if (!thread) return yield* fail(`Thread ${threadId} disappeared before its turn ran.`);
        // The turn waited for its worktree to be added; adding it may have failed meanwhile.
        const worktree = thread.worktree === null ? null : (JSON.parse(thread.worktree) as WorktreeView);
        if (worktree && worktree.state !== "ready") {
          return yield* fail(`This thread's worktree isn't ready (${worktree.state}): ${worktree.error ?? "see the thread"}`);
        }
        const cwd = threadFolder(thread.path, thread.worktree);
        // A setup command held for want of trust is asked about, and run if allowed, before the agent starts.
        if (worktree?.held && worktree.path) yield* runHeldSetup(threadId, turnId, worktree.held, worktree.path);
        // A turn whose route's provider reported a reset still ahead starts on its fallback (DESIGN §9.5), and a light or
        // heavy one runs at its own effort (§8.7).
        const own = yield* sql<{ type: string; moved: string }>`
          select type, json_extract(payload, '$.to') as moved from events
          where thread_id = ${threadId} and type in ('turn.rerouted', 'turn.effort.set') and json_extract(payload, '$.turnId') = ${turnId}`;
        const sticky = own.find((e) => e.type === "turn.rerouted");
        const effort = own.find((e) => e.type === "turn.effort.set")?.moved as Effort | undefined;
        const route = JSON.parse(sticky?.moved ?? thread.route) as Route;
        const adapter = registry[route.harness];
        if (!adapter) return yield* fail(`The ${route.harness} harness is not available in this verdandid. Pick another route.`);
        live.set(threadId, adapter);
        const limits =
          thread.limits && thread.task_id
            ? {
                ...(JSON.parse(thread.limits) as TaskLimits),
                taskId: thread.task_id,
                spentUsd: thread.spent_usd,
                spentTurns: thread.spent_turns,
              }
            : undefined;
        // A background review or a handoff runs unattended with no Verdandi tools, so nothing it does takes effect
        // before the user allows it.
        const aux = thread.review === null ? null : (JSON.parse(thread.review) as AuxStarted);
        const nudge = aux ? undefined : memoryNudge(thread.turn_number, toolSettings.memoryNudgeEvery);
        const context = yield* contextAllowed(threadId, turnId, adapter, cwd, aux !== null);
        const delegate = aux ? undefined : delegateFor(threadId, turnId, (yield* projectEscalation(thread.path)).delegation);
        if (!context.allowed)
          return yield* fail(
            `Verdandi didn't start the agent: its injection scan flagged ${listed(context.files)}, which the ${route.harness} harness would load into the agent's context, and they weren't allowed. Remove what the scan flagged, or send the turn again and allow them if you trust them.`,
          );
        // A new session on another harness than the thread's last starts from a summary of the thread (DESIGN §8.2
        // lever 5). A revert's fork resumes its own session, so it needs none.
        const handoff =
          !aux &&
          thread.session_id === null &&
          thread.session_harness !== null &&
          thread.session_harness !== route.harness &&
          !thread.pending_fork
            ? yield* handOff(threadId, turnId, thread.session_harness, route.harness, thread.path, cwd)
            : undefined;
        // The turn's file-tool calls, which say whether it changed files in a folder without checkpoints.
        const calls: Item[] = [];
        // Whether a tool call failed, so the task's tool errors are counted at the turn's end.
        let toolFailed = false;
        /**
         * Records a provider's failure and answers the harness waiting on it (DESIGN §9.5): moved to the fallback the decider
         * chose, then allowed, or denied with why it stops. A failed dispatch denies it too, so the harness never waits forever.
         */
        const answerFailure = (event: Extract<HarnessEvent, { type: "provider.failed" }>) =>
          Effect.gen(function* () {
            const commandId = randomUUID() as CommandId;
            yield* engine.dispatch({ type: "harness.report", commandId, threadId, turnId, event });
            const recorded = yield* sql<{
              type: string;
              payload: string;
            }>`select type, payload from events where command_id = ${commandId}`;
            const moved = recorded.find((r) => r.type === "turn.rerouted");
            if (moved) {
              yield* adapter.reroute(threadId, (JSON.parse(moved.payload) as { to: Route }).to);
              return yield* adapter.respond(threadId, event.requestId, { decision: "allow" });
            }
            const failed = recorded.find((r) => r.type === "provider.failed");
            const why = failed && (JSON.parse(failed.payload) as { noFallback?: string }).noFallback;
            yield* adapter.respond(threadId, event.requestId, { decision: "deny", ...(why && { feedback: why }) });
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.andThen(adapter.respond(threadId, event.requestId, { decision: "deny" }), Effect.failCause(cause)),
            ),
          );
        yield* adapter
          .run({
            threadId,
            cwd,
            route,
            resumeSessionId: thread.session_id ?? undefined,
            turnId,
            text,
            mode,
            ...(attachments.length > 0 && { attachments: attachments.map((a) => ({ ...a, path: join(attachmentsDir, a.id) })) }),
            // A thread someone other than the owner writes in from a chat app gets none of workspace.yaml's folders.
            ...(thread.confined === 1 && { confined: true as const }),
            steers,
            ...(aux
              ? {}
              : {
                  // A confined thread's session gets none of the tools that read or write the owner's memory, sessions or
                  // skills, only report_blocked (ADR 0036). Fixed for the thread, so its session's tool list never changes.
                  tools: thread.confined === 1 ? tools.filter((t) => confinedTools.has(t.name)) : tools,
                  scan: scanFor({ threadId, turnId }),
                  ...(delegate && { delegate }),
                  mcp: mcpFor(threadId, turnId, cwd),
                  screen: (text: string) => Effect.runPromise(screen("mcp", text, { threadId, turnId })),
                  ...(approvals.smart && { guard: guardFor(threadId, turnId) }),
                  summarize: summarizeFor(threadId, turnId, thread.task_id, thread.path, cwd),
                }),
            // The snapshot a new session starts with goes to its first turn only (DESIGN §14.2), and so does a handoff's summary.
            // Nor the owner's memory.
            ...(thread.confined === 1 ? {} : memoryFor(thread.memory_snapshot, turnId)),
            ...(handoff && { handoff }),
            // Every Nth turn of the thread nudges the agent to save memory, in the turn's message, never the system prompt.
            ...(nudge && { nudge }),
            ...(limits && { limits }),
            ...(effort && { effort }),
            // A revert waits to fork the conversation until this turn (ADR 0004).
            ...(thread.pending_fork && {
              fork: {
                ...(JSON.parse(thread.pending_fork) as NonNullable<HarnessRunInput["fork"]>),
                ...(thread.transcript_path && { transcriptPath: thread.transcript_path }),
              },
            }),
          })
          .pipe(
            Stream.runForEach((event) => {
              if (event.type === "text.delta") return engine.publishDelta(threadId, turnId, event.text);
              if (event.type === "item" && event.item.kind === "tool.call") calls.push(event.item);
              if (event.type === "item" && event.item.kind === "tool.result" && event.item.isError) toolFailed = true;
              if (event.type === "provider.failed") return answerFailure(event);
              if (event.type !== "turn.finished") return report(threadId, turnId, event);
              finished = true;
              return Effect.gen(function* () {
                const failed =
                  event.status === "success" && !aux && (yield* changedFiles(threadId, turnId, cwd, calls))
                    ? yield* verify(threadId, turnId, thread.path, cwd)
                    : undefined;
                // A failed verifier, or else the agent having reported it's blocked, or else the same tool error repeating
                // in the task, may escalate it (DESIGN §8.7): one trigger per turn end, the strongest signal first.
                const [blocked] =
                  failed || aux
                    ? []
                    : yield* sql<{ reason: string }>`
                      select json_extract(payload, '$.reason') as reason from items
                      where turn_id = ${turnId} and json_extract(payload, '$.kind') = 'blocked' order by idx desc limit 1`;
                const trigger = failed
                  ? ({ kind: "verifier", run: failed } as const)
                  : blocked
                    ? ({ kind: "blocked", reason: blocked.reason } as const)
                    : toolFailed && !aux
                      ? yield* repeatedErrorIn(threadId, thread.path)
                      : undefined;
                // Recorded on the turn before it completes, as a failed verifier and a blocked report are, so a follower
                // such as `verdandi run` knows the decision is coming.
                if (trigger?.kind === "repeated-error") {
                  const { tool, count } = trigger;
                  yield* engine
                    .dispatch({ type: "task.error.repeat", commandId: randomUUID() as CommandId, threadId, turnId, tool, count })
                    .pipe(Effect.catchTag("CommandRejected", () => Effect.void)); // the turn ended first
                }
                yield* report(threadId, turnId, event);
                // A review's reply becomes proposals on the thread it reviewed, and a handoff's goes to the turn waiting
                // for it (on turn.completed); neither is escalated or reviewed.
                if (aux) {
                  if (aux.type === "review.started" && event.status === "success") yield* settleReview(turnId, threadId, aux.reviews);
                  return;
                }
                // Once the turn has completed, the decider decides whether the trigger escalates it.
                if (trigger) {
                  yield* engine.dispatch({
                    type: "task.escalate",
                    commandId: randomUUID() as CommandId,
                    threadId,
                    turnId,
                    nextTurnId: randomUUID() as TurnId,
                    trigger,
                  });
                } else if (reviews.enabled && event.status === "success" && thread.task_id) {
                  // A task whose turn finished with nothing to escalate may hold something worth keeping (DESIGN §14.5).
                  yield* FiberSet.run(turns, askReview(threadId, turnId, thread.task_id));
                }
              });
            }),
          );
        if (!finished) yield* fail("The harness stopped without finishing the turn.");
      }).pipe(
        Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) || finished ? Effect.failCause(cause) : fail(errorMessage(cause)))),
        Effect.ensuring(Effect.sync(() => live.delete(threadId))),
        Effect.ignore,
      );
    };

    const running = yield* sql<{ id: string; thread_id: string }>`select id, thread_id from turns where status = 'running'`;
    yield* Effect.forEach(
      running,
      (t) =>
        engine.dispatch({
          type: "turn.recover",
          commandId: randomUUID() as CommandId,
          threadId: t.thread_id as ThreadId,
          turnId: t.id as TurnId,
        }),
      { discard: true },
    );

    const startTurn = (threadId: ThreadId, turnId: TurnId, text: string, mode: InteractionMode, attachments: readonly AttachmentRef[]) =>
      Effect.gen(function* () {
        // Registered before the turn forks, so a steer accepted right after turn.started is never lost.
        const queue = yield* Queue.unbounded<string>();
        steerQueues.set(turnId, queue);
        const done = Effect.andThen(
          Effect.sync(() => steerQueues.delete(turnId)),
          Queue.shutdown(queue),
        );
        // The end checkpoint waits for the harness to stop, even an interrupted one, and the next turn waits for it.
        yield* enqueue(
          threadId,
          Effect.andThen(
            saveCheckpoint(threadId, turnId, "start"),
            runTurn(threadId, turnId, text, mode, attachments, Stream.fromQueue(queue)),
          ).pipe(Effect.ensuring(saveCheckpoint(threadId, turnId, "end")), Effect.ensuring(done)),
          turnId,
        );
      });

    const reportWorktree = (threadId: ThreadId, report: WorktreeReport) =>
      engine.dispatch({ type: "worktree.report", commandId: randomUUID() as CommandId, threadId, report });
    const worktreeOf = (threadId: ThreadId) =>
      Effect.map(
        sql<{ path: string; worktree: string | null }>`
          select p.path, t.worktree from threads t join projects p on p.id = t.project_id where t.id = ${threadId}`,
        ([row]) => (row?.worktree ? { projectPath: row.path, worktree: JSON.parse(row.worktree) as WorktreeView } : undefined),
      );

    /**
     * Adds the thread's requested worktree, then runs the project's setup command in it (DESIGN §13), if the user trusts it
     * in the project; else holds it for the thread's next turn to ask about.
     */
    const createWorktree = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const found = yield* worktreeOf(threadId);
        if (found?.worktree.state !== "creating") return;
        const { projectPath, worktree } = found;
        const added = yield* Effect.result(addWorktree(projectPath, worktreesDir, worktree.branch, worktree.root));
        if (Result.isFailure(added))
          return yield* reportWorktree(threadId, { type: "failed", action: "create", error: added.failure.message });
        yield* reportWorktree(threadId, { type: "created", ...added.success });
        const setup = worktreeSetup(projectPath);
        if (Result.isFailure(setup))
          return yield* reportWorktree(threadId, {
            type: "setup",
            run: { command: "setup", passed: false, exitCode: null, durationMs: 0, output: setup.failure },
          });
        const command = setup.success;
        if (!command) return;
        if (!(yield* isTrusted(threadId, [command]).pipe(Effect.provideService(SqlClient.SqlClient, sql))))
          return yield* reportWorktree(threadId, { type: "setup.held", command });
        yield* reportWorktree(threadId, { type: "setup", run: yield* runVerifier(command, added.success.path) });
      }).pipe(Effect.catchCause((cause) => Effect.logWarning(`Could not add the worktree of thread ${threadId}.`, cause)));

    /** Asks on turn `turnId` about the worktree setup command held for want of trust, and runs it if allowed. */
    const runHeldSetup = (threadId: ThreadId, turnId: TurnId, command: string, path: string) =>
      Effect.gen(function* () {
        const run = (yield* trusted(threadId, turnId, "setup", [command]))
          ? yield* runVerifier(command, path)
          : {
              command,
              passed: false,
              exitCode: null,
              durationMs: 0,
              output: `Not run: the project's setup command from ${trustFiles.setup} wasn't allowed to run. Run it in the worktree's terminal if you need it.`,
            };
        yield* reportWorktree(threadId, { type: "setup", run });
      });

    /**
     * Restores the thread's files from checkpoint `from` and reports how it went (DESIGN §13). A revert saves them as
     * `save` first, so it can be undone, then restores only the paths its `turnIds` changed in the thread's folder, or
     * the whole folder when one of them has no checkpoints, and names the files their file tools changed outside it.
     * Undoing it restores the `paths` it restored, or the whole folder without them.
     */
    const restoreFiles = (
      threadId: ThreadId,
      from: string,
      scope: { readonly save: string; readonly turnIds: readonly TurnId[] } | { readonly paths: readonly string[] | undefined },
    ) =>
      Effect.gen(function* () {
        const cwd = yield* loadThreadFolder(threadId).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        if (!cwd) return;
        const calls =
          "turnIds" in scope
            ? yield* sql<{ payload: string }>`
                select payload from items where turn_id in (select value from json_each(${JSON.stringify(scope.turnIds)}))
                  and json_extract(payload, '$.kind') = 'tool.call'`
            : [];
        const { outside } = editedFiles(
          cwd,
          calls.map((c) => JSON.parse(c.payload) as Item),
        );
        const done = yield* Effect.result(
          Effect.gen(function* () {
            if ("save" in scope) yield* checkpoint(cwd, scope.save);
            if (!("turnIds" in scope)) return { whole: false, paths: yield* restore(cwd, from, scope.paths && new Set(scope.paths)) };
            const only = yield* changedByTurns(cwd, threadId, scope.turnIds);
            return { whole: only === undefined, paths: yield* restore(cwd, from, only) };
          }),
        );
        yield* engine.dispatch({
          type: "files.report",
          commandId: randomUUID() as CommandId,
          threadId,
          from,
          ...(Result.isSuccess(done)
            ? { ...("save" in scope && { saved: scope.save }), ...done.success }
            : { error: done.failure.message, whole: false }),
          outside,
        });
      }).pipe(Effect.catchCause((cause) => Effect.logWarning(`Could not restore the files of thread ${threadId}.`, cause)));

    /** Removes the thread's worktree, keeping its branch; git keeps one with uncommitted changes unless `force`. */
    const dropWorktree = (threadId: ThreadId, force: boolean) =>
      Effect.gen(function* () {
        const found = yield* worktreeOf(threadId);
        if (found?.worktree.state !== "removing") return;
        const { root } = found.worktree;
        const removed = root ? yield* Effect.result(removeWorktree(found.projectPath, root, force)) : Result.succeed(undefined);
        yield* reportWorktree(
          threadId,
          Result.isFailure(removed) ? { type: "failed", action: "remove", error: removed.failure.message } : { type: "removed" },
        );
      }).pipe(Effect.catchCause((cause) => Effect.logWarning(`Could not remove the worktree of thread ${threadId}.`, cause)));

    yield* engine.react((stored) => {
      const e = stored.event;
      if (e.type === "turn.started") return startTurn(e.threadId, e.turnId, e.text, e.mode ?? "build", e.attachments ?? []);
      // In `turns`, so `drain` waits for the review it starts.
      if (e.type === "review.requested") return FiberSet.run(turns, startReview(e)).pipe(Effect.asVoid);
      if (e.type === "turn.steered") {
        const queue = steerQueues.get(e.turnId);
        return queue ? Queue.offer(queue, e.text).pipe(Effect.asVoid) : Effect.void;
      }
      // Committed right before the approval or denial it goes with, so the harness switches before the agent's next step.
      const moved = e.type === "task.rerouted" || (e.type === "task.escalated" && e.trigger === "plan-rejected") ? e.to : undefined;
      if (moved) return live.get(e.threadId)?.reroute(e.threadId, moved) ?? Effect.void;
      // An archived skill leaves the folder Claude Code loads, and a restored one goes back (DESIGN §14.4).
      if (e.type === "skill.state.changed") {
        const error = placeSkill(skillFolders, e.skill, e.to === "archived");
        return error ? Effect.logWarning(`${error} The next skill curation sweep tries again.`) : Effect.void;
      }
      // The user's revert is written at once, inside its dispatch, so its receipt means the outcome is recorded too.
      if (e.type === "skill.reverted") {
        const { action, skill, path } = e.change;
        const error = applyChange(skillFolders, e.change, revertStale(e.change));
        return engine
          .dispatch({
            type: "skill.report",
            commandId: randomUUID() as CommandId,
            threadId: e.threadId,
            requestId: e.changeId,
            action,
            skill,
            path,
            ...(error && { error }),
          })
          .pipe(Effect.ignoreCause({ log: "Warn", message: `Could not record how skill revert ${e.changeId} went.` }));
      }
      // An allowed hub install is written at once, inside its answer's dispatch, so the receipt means its outcome is recorded too.
      if (e.type === "skill.install.resolved") {
        if (e.resolution.decision !== "allow") return Effect.void;
        return Effect.gen(function* () {
          const [row] = yield* sql<{ payload: string }>`select payload from requests where id = ${e.requestId}`;
          if (!row) return;
          const { skill, pin, digests, changes, from } = JSON.parse(row.payload) as Extract<Event, { type: "skill.install.proposed" }>;
          // An install proposed against another state (installed, updated or uninstalled since) would write the wrong files.
          const now = yield* loadInstall(skill).pipe(Effect.provideService(SqlClient.SqlClient, sql));
          const error =
            now?.pin.sha === from
              ? applyChanges(skillFolders, changes)
              : `${skill} was ${now ? `installed at ${now.pin.sha.slice(0, 12)}` : "uninstalled"} since this was proposed, so nothing was written. Install or update it again.`;
          yield* engine.dispatch({
            type: "skill.install.report",
            commandId: randomUUID() as CommandId,
            threadId: e.threadId,
            requestId: e.requestId,
            skill,
            pin,
            digests,
            ...(error && { error }),
          });
        }).pipe(Effect.ignoreCause({ log: "Warn", message: `Could not install hub skill request ${e.requestId}.` }));
      }
      // Uninstalling moves the folder out of what Claude Code loads, never deleting it, inside the dispatch, so the
      // receipt means its outcome is recorded too.
      if (e.type === "skill.uninstall.requested") {
        const error = archiveSkill(skillFolders, e.skill);
        return engine
          .dispatch({ type: "skill.uninstall.report", commandId: randomUUID() as CommandId, skill: e.skill, ...(error && { error }) })
          .pipe(
            Effect.andThen(error ? Effect.logWarning(error) : Effect.void),
            Effect.ignoreCause({ log: "Warn", message: `Could not record how uninstalling ${e.skill} went.` }),
          );
      }
      // A skill proposal is Verdandi's own request: its answer writes the skill, in `turns` so `drain` waits for it. So is a
      // trust request, whose answer a turn waits on.
      if (e.type === "approval.resolved") {
        const trust = trustAnswers.get(e.requestId);
        if (trust) return Deferred.succeed(trust, e.resolution.decision === "allow").pipe(Effect.asVoid);
        return Effect.andThen(
          live.get(e.threadId)?.respond(e.threadId, e.requestId, e.resolution) ?? Effect.void,
          FiberSet.run(turns, skills.settle(e)),
        ).pipe(Effect.asVoid);
      }
      if (e.type === "turn.completed") {
        // A handoff's or compression's turn, however it ended, lets the turn waiting for its summary go on.
        const aux = auxReplies.get(e.threadId);
        const replied = aux
          ? Effect.andThen(
              e.status === "success" ? Effect.orElseSucceed(lastReply(e.turnId), () => undefined) : Effect.succeed(undefined),
              (reply) => Deferred.succeed(aux, reply),
            )
          : Effect.void;
        const turn = latest.get(e.threadId);
        // Forked into `turns`, so the dispatch doesn't wait for the harness to stop or the trajectory to be written, and `drain` does.
        const stop =
          e.status === "interrupted" && turn?.turnId === e.turnId ? FiberSet.run(turns, Fiber.interrupt(turn.fiber)) : Effect.void;
        return Effect.andThen(
          replied,
          Effect.andThen(stop, FiberSet.run(turns, Effect.andThen(record(e.threadId, e.turnId), recordOutcomes(e.threadId)))),
        ).pipe(Effect.asVoid);
      }
      // Queued like turns: a turn sent while its worktree is being added waits for it.
      if (e.type === "thread.worktree.requested") return enqueue(e.threadId, createWorktree(e.threadId));
      if (e.type === "thread.worktree.removal.requested") return enqueue(e.threadId, dropWorktree(e.threadId, e.force));
      // A route change is an override of the running task, and ends it. A rating, or an escalation, which commits after
      // its turn completed, changes its task's outcome.
      if (e.type === "thread.route.changed" || e.type === "task.rated" || e.type === "task.escalated")
        return FiberSet.run(turns, recordOutcomes(e.threadId)).pipe(Effect.asVoid);
      // Queued like turns, so the next turn starts on the restored files. A revert changes its tasks' outcomes.
      if (e.type === "thread.reverted" || e.type === "thread.revert.undone") {
        const files =
          e.type === "thread.reverted"
            ? e.files &&
              restoreFiles(e.threadId, checkpointRef(e.threadId, e.toTurnId, "end"), {
                save: revertRef(e.threadId, stored.seq),
                turnIds: e.turnIds,
              })
            : e.restore && restoreFiles(e.threadId, e.restore, { paths: e.paths });
        return Effect.andThen(files ? enqueue(e.threadId, files) : Effect.void, FiberSet.run(turns, recordOutcomes(e.threadId))).pipe(
          Effect.asVoid,
        );
      }
      return Effect.void;
    });

    // Worktrees a stopped verdandid was adding or removing. Adding again reuses a worktree it had finished adding.
    const unfinished = yield* sql<{ id: ThreadId; state: WorktreeView["state"] }>`
      select id, json_extract(worktree, '$.state') as state from threads where json_extract(worktree, '$.state') in ('creating', 'removing')`;
    yield* Effect.forEach(unfinished, (t) => enqueue(t.id, t.state === "creating" ? createWorktree(t.id) : dropWorktree(t.id, false)), {
      discard: true,
    });

    // Turns that completed while nothing was listening: before a crash, in the recovery above, or before trajectories existed.
    yield* FiberSet.run(
      turns,
      Effect.all([
        unrecordedTurns.pipe(Effect.flatMap((missing) => Effect.forEach(missing, (t) => record(t.thread_id, t.id), { discard: true }))),
        staleOutcomeThreads.pipe(Effect.flatMap((stale) => Effect.forEach(stale, (t) => recordOutcomes(t.thread_id), { discard: true }))),
      ]).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.ignore),
    );

    return Reactor.of({ drain: FiberSet.awaitEmpty(turns) });
  }),
);
