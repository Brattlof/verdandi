import type { HarnessAdapter, HarnessId } from "@verdandi/contracts";
import { Layer } from "effect";
import { loadSpendCaps } from "../config/spend-caps.ts";
import { SqlLive } from "../persistence/db.ts";
import { routingFor } from "../routing/routing.ts";
import { attachmentsDir } from "../workspace/attachments.ts";
import { EngineLive, type Projector } from "./engine.ts";
import { AttachmentsDir, HarnessRegistry, ReactorLive } from "./reactor.ts";

/** verdandid's core: database, engine and reactor, with the given harness adapters, which new tasks are routed over. */
export const AppLayer = (
  home: string,
  harnesses: Partial<Record<HarnessId, HarnessAdapter>>,
  options: { readonly project?: Projector } = {},
) =>
  ReactorLive.pipe(
    Layer.provideMerge(EngineLive({ ...options, routing: routingFor(harnesses), spendCaps: loadSpendCaps(home) })),
    Layer.provideMerge(Layer.succeed(HarnessRegistry, harnesses)),
    Layer.provideMerge(Layer.succeed(AttachmentsDir, attachmentsDir(home))),
    Layer.provideMerge(SqlLive(home)),
  );
