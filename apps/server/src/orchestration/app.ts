import type { HarnessAdapter, HarnessId } from "@verdandi/contracts";
import { Layer } from "effect";
import { SqlLive } from "../persistence/db.ts";
import { routingFor } from "../routing/routing.ts";
import { EngineLive, type Projector } from "./engine.ts";
import { HarnessRegistry, ReactorLive } from "./reactor.ts";

/** verdandid's core: database, engine and reactor, with the given harness adapters, which new tasks are routed over. */
export const AppLayer = (
  home: string,
  harnesses: Partial<Record<HarnessId, HarnessAdapter>>,
  options: { readonly project?: Projector } = {},
) =>
  ReactorLive.pipe(
    Layer.provideMerge(EngineLive({ ...options, routing: routingFor(harnesses) })),
    Layer.provideMerge(Layer.succeed(HarnessRegistry, harnesses)),
    Layer.provideMerge(SqlLive(home)),
  );
