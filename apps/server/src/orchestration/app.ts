import type { HarnessAdapter, HarnessId } from "@goldiloop/contracts";
import { Layer } from "effect";
import { SqlLive } from "../persistence/db.ts";
import { EngineLive, type Projector } from "./engine.ts";
import { HarnessRegistry, ReactorLive } from "./reactor.ts";

/** goldiloopd's core: database, engine and reactor, with the given harness adapters. */
export const AppLayer = (
  home: string,
  harnesses: Partial<Record<HarnessId, HarnessAdapter>>,
  options: { readonly project?: Projector } = {},
) =>
  ReactorLive.pipe(
    Layer.provideMerge(EngineLive(options)),
    Layer.provideMerge(Layer.succeed(HarnessRegistry, harnesses)),
    Layer.provideMerge(SqlLive(home)),
  );
