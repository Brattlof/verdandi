import { join } from "node:path";
import type { HarnessAdapter, HarnessId } from "@verdandi/contracts";
import { Decide } from "@verdandi/decisions";
import { Effect, Layer, Result } from "effect";
import { loadApprovalSettings } from "../approvals/approvals-config.ts";
import { attachmentsDir } from "../attachments/attachments.ts";
import { workspaceDir } from "../home/workspace.ts";
import { loadMemorySettings } from "../memory/memory-config.ts";
import { loadMcp } from "../native/mcp-config.ts";
import { loadReviewSettings } from "../review/review-config.ts";
import { catalogFor, routingFor, rulesDecide } from "../routing/routing.ts";
import { loadSkillFolders } from "../skills/skills-config.ts";
import { loadSpendCaps } from "../spend/spend-caps.ts";
import { SqlLive } from "./db.ts";
import { EngineLive, type Projector } from "./engine.ts";
import {
  ApprovalSettings,
  AttachmentsDir,
  HarnessRegistry,
  McpConfig,
  ProfileSkills,
  ProjectEscalation,
  ReactorLive,
  ReviewSettings,
  ToolSettings,
  WorkspaceDir,
  WorktreesDir,
} from "./reactor.ts";

/** verdandid's core: database, engine and reactor, with the given harness adapters, which new tasks are routed over. */
export const AppLayer = (
  home: string,
  harnesses: Partial<Record<HarnessId, HarnessAdapter>>,
  /**
   * `spendCapsHome`: the home whose `spend-caps.yaml` applies, when not `home` (a batch run's own home).
   * `verifiers`: verifiers Verdandi's caller supplies for a project in place of its policy's (a batch task's `verify`,
   * kept out of its copy), which run without asking, since they aren't the project's own.
   * `decide`: the decision layer, `rules` unless the caller brings another backend (DESIGN §9.8).
   */
  options: {
    readonly project?: Projector;
    readonly spendCapsHome?: string;
    readonly verifiers?: (projectPath: string) => readonly string[];
    readonly decide?: Decide["Service"];
    readonly now?: () => Date;
  } = {},
) => {
  const routing = routingFor(harnesses);
  // A broken policy runs no verifiers and counts no repeated errors; it already rejects the next routed turn, naming the file
  // and key, and a delegated subtask, which keeps the built-in delegation limits until it's fixed.
  const escalation = (projectPath: string) =>
    Effect.flatMap(routing(projectPath), ({ policy, builtIn }) => {
      const supplied = options.verifiers?.(projectPath) ?? [];
      return Result.isSuccess(policy)
        ? Effect.succeed({
            ...(supplied.length > 0
              ? { verifiers: supplied, fromProject: false }
              : { verifiers: policy.success.verifiers, fromProject: true }),
            repeatedErrors: policy.success.escalation.repeatedErrors,
            delegation: policy.success.delegation,
          })
        : Effect.as(Effect.logWarning(`Skipped the project's verifiers and repeated errors: ${policy.failure}`), {
            verifiers: [],
            fromProject: false,
            repeatedErrors: 0,
            delegation: builtIn.delegation,
          });
    });
  return ReactorLive.pipe(
    Layer.provideMerge(
      EngineLive({
        ...options,
        routing,
        decide: options.decide ?? rulesDecide,
        catalog: catalogFor(harnesses),
        spendCaps: loadSpendCaps(options.spendCapsHome ?? home),
      }),
    ),
    Layer.provideMerge(Layer.succeed(ProjectEscalation, escalation)),
    // The reactor scans Verdandi's tool results with the same decision layer as the engine.
    Layer.provideMerge(Layer.succeed(Decide, options.decide ?? rulesDecide)),
    // Stopping closes the sessions harnesses keep warm between turns, so no harness process outlives verdandid.
    Layer.provideMerge(
      Layer.effect(
        HarnessRegistry,
        Effect.acquireRelease(Effect.succeed(harnesses), (registry) =>
          Effect.forEach(Object.values(registry), (harness) => harness?.close() ?? Effect.void, { discard: true }),
        ),
      ),
    ),
    Layer.provideMerge(Layer.succeed(AttachmentsDir, attachmentsDir(home))),
    Layer.provideMerge(Layer.succeed(McpConfig, (folder: string) => loadMcp(home, folder))),
    Layer.provideMerge(Layer.succeed(WorktreesDir, join(home, "worktrees"))),
    Layer.provideMerge(Layer.succeed(WorkspaceDir, workspaceDir(home))),
    Layer.provideMerge(Layer.sync(ProfileSkills, () => loadSkillFolders(home))),
    Layer.provideMerge(Layer.sync(ReviewSettings, () => loadReviewSettings(home))),
    Layer.provideMerge(Layer.sync(ApprovalSettings, () => loadApprovalSettings(home))),
    Layer.provideMerge(
      Layer.sync(ToolSettings, () => {
        const memory = loadMemorySettings(home);
        return { approveMemorySaves: memory.approveSaves, memoryNudgeEvery: memory.nudgeEvery };
      }),
    ),
    Layer.provideMerge(SqlLive(home)),
  );
};
