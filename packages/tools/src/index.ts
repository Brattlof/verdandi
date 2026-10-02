import type { HarnessTool, SessionHit } from "@verdandi/contracts";
import type { Effect } from "effect";
import type { Screen, ToolAt, ToolFailed } from "./define.ts";
import { type MemoryServices, memorySaveTool, memorySearchTool } from "./memory.ts";
import { reportBlockedTool } from "./report-blocked.ts";
import { sessionSearchTool } from "./session-search.ts";

export { type Args, defineTool, type Screen, type ToolAt, ToolFailed } from "./define.ts";
export { hitsForAgent } from "./session-search.ts";

/** What Verdandi's tools need from verdandid. */
export type ToolServices = {
  readonly search: (query: string, allProjects: boolean, at: ToolAt) => Effect.Effect<readonly SessionHit[]>;
  readonly block: (reason: string, at: ToolAt) => Effect.Effect<void, ToolFailed>;
  readonly memory: MemoryServices;
  /** The user approves each memory save (DESIGN §14.2). */
  readonly approveMemorySaves: boolean;
  /** Scans the search tools' results for injection before the agent gets them. */
  readonly screen: Screen;
};

/** Every Verdandi tool, in a fixed order: harnesses serve this list unchanged for a session's life (DESIGN §9.6). */
export const verdandiTools = (services: ToolServices): readonly HarnessTool[] => [
  sessionSearchTool(services.search, services.screen),
  reportBlockedTool(services.block),
  memorySaveTool(services.memory, services.approveMemorySaves),
  memorySearchTool(services.memory, services.screen),
];
