import { join } from "node:path";
import type { HarnessAdapter, HarnessId } from "@verdandi/contracts";
import { Effect, Layer, Result } from "effect";
import { attachmentsDir } from "../attachments/attachments.ts";
import { loadMemorySettings } from "../memory/memory-config.ts";
import { catalogFor, routingFor } from "../routing/routing.ts";
import { loadSpendCaps } from "../spend/spend-caps.ts";
import { SqlLive } from "./db.ts";
import { EngineLive, type Projector } from "./engine.ts";
import { AttachmentsDir, HarnessRegistry, ProjectVerifiers, ReactorLive, ToolSettings, WorktreesDir } from "./reactor.ts";

/** verdandid's core: database, engine and reactor, with the given harness adapters, which new tasks are routed over. */
export const AppLayer = (
  home: string,
  harnesses: Partial<Record<HarnessId, HarnessAdapter>>,
  /**
   * `spendCapsHome`: the home whose `spend-caps.yaml` applies, when not `home` (a batch run's own home).
   * `defaultVerifiers`: verifiers for a project whose policy names none (a batch task's `verify`, kept out of its copy).
   */
  options: {
    readonly project?: Projector;
    readonly spendCapsHome?: string;
    readonly defaultVerifiers?: (projectPath: string) => readonly string[];
  } = {},
) => {
  const routing = routingFor(harnesses);
  // A broken policy runs no verifiers; it already rejects the next routed turn, naming the file and key.
  const verifiers = (projectPath: string) =>
    Effect.flatMap(routing(projectPath), ({ policy }) =>
      Result.isSuccess(policy)
        ? Effect.succeed(policy.success.verifiers.length > 0 ? policy.success.verifiers : (options.defaultVerifiers?.(projectPath) ?? []))
        : Effect.as(Effect.logWarning(`Skipped the project's verifiers: ${policy.failure}`), []),
    );
  return ReactorLive.pipe(
    Layer.provideMerge(
      EngineLive({ ...options, routing, catalog: catalogFor(harnesses), spendCaps: loadSpendCaps(options.spendCapsHome ?? home) }),
    ),
    Layer.provideMerge(Layer.succeed(ProjectVerifiers, verifiers)),
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
    Layer.provideMerge(Layer.succeed(WorktreesDir, join(home, "worktrees"))),
    Layer.provideMerge(
      Layer.sync(ToolSettings, () => {
        const memory = loadMemorySettings(home);
        return { approveMemorySaves: memory.approveSaves, memoryNudgeEvery: memory.nudgeEvery };
      }),
    ),
    Layer.provideMerge(SqlLive(home)),
  );
};
