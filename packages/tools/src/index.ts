import type { HarnessTool, SessionHit } from "@verdandi/contracts";
import type { Effect } from "effect";
import type { ToolAt, ToolFailed } from "./define.ts";
import { reportBlockedTool } from "./report-blocked.ts";
import { sessionSearchTool } from "./session-search.ts";

export { type Args, defineTool, type ToolAt, ToolFailed } from "./define.ts";
export { hitsForAgent } from "./session-search.ts";

/** What Verdandi's tools need from verdandid. */
export type ToolServices = {
  readonly search: (query: string, allProjects: boolean, at: ToolAt) => Effect.Effect<readonly SessionHit[]>;
  readonly block: (reason: string, at: ToolAt) => Effect.Effect<void, ToolFailed>;
};

/** Every Verdandi tool, in a fixed order: harnesses serve this list unchanged for a session's life (DESIGN §9.6). */
export const verdandiTools = (services: ToolServices): readonly HarnessTool[] => [
  sessionSearchTool(services.search),
  reportBlockedTool(services.block),
];
