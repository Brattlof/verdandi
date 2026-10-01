import type { HarnessAdapter, HarnessId } from "@verdandi/contracts";
import { Effect, Layer, Result } from "effect";
import { loadSpendCaps } from "../config/spend-caps.ts";
import { SqlLive } from "../persistence/db.ts";
import { routingFor } from "../routing/routing.ts";
import { attachmentsDir } from "../workspace/attachments.ts";
import { EngineLive, type Projector } from "./engine.ts";
import { AttachmentsDir, HarnessRegistry, ProjectVerifiers, ReactorLive } from "./reactor.ts";

/** verdandid's core: database, engine and reactor, with the given harness adapters, which new tasks are routed over. */
export const AppLayer = (
  home: string,
  harnesses: Partial<Record<HarnessId, HarnessAdapter>>,
  options: { readonly project?: Projector } = {},
) => {
  const routing = routingFor(harnesses);
  // A broken policy runs no verifiers; it already rejects the next routed turn, naming the file and key.
  const verifiers = (projectPath: string) =>
    Effect.flatMap(routing(projectPath), ({ policy }) =>
      Result.isSuccess(policy)
        ? Effect.succeed(policy.success.verifiers)
        : Effect.as(Effect.logWarning(`Skipped the project's verifiers: ${policy.failure}`), []),
    );
  return ReactorLive.pipe(
    Layer.provideMerge(EngineLive({ ...options, routing, spendCaps: loadSpendCaps(home) })),
    Layer.provideMerge(Layer.succeed(ProjectVerifiers, verifiers)),
    Layer.provideMerge(Layer.succeed(HarnessRegistry, harnesses)),
    Layer.provideMerge(Layer.succeed(AttachmentsDir, attachmentsDir(home))),
    Layer.provideMerge(SqlLive(home)),
  );
};
