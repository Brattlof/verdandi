import { randomUUID } from "node:crypto";
import type { CommandId } from "@verdandi/contracts";
import { Effect } from "effect";
import { Engine } from "../event-store/engine.ts";

/**
 * Allows every trust request as it's raised, as a user who trusts each project's own commands would. For tests whose
 * projects' verifiers or setup should just run; a request whose turn ended first is left alone.
 */
export const allowTrustRequests = Effect.flatMap(Engine, (engine) =>
  engine.react(({ event: e }) =>
    e.type === "commands.trust.requested"
      ? engine
          .dispatch({
            type: "approval.respond",
            commandId: randomUUID() as CommandId,
            threadId: e.threadId,
            requestId: e.requestId,
            resolution: { decision: "allow" },
          })
          .pipe(Effect.ignore)
      : Effect.void,
  ),
);
