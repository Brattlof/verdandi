import type { HarnessTool, SessionHit } from "@verdandi/contracts";
import type { Effect } from "effect";
import { cronjobTool, type ScheduleServices } from "./cronjob.ts";
import type { Screen, ToolAt, ToolFailed } from "./define.ts";
import { type MemoryServices, memorySaveTool, memorySearchTool } from "./memory.ts";
import { reportBlockedTool } from "./report-blocked.ts";
import { sessionSearchTool } from "./session-search.ts";
import { type ProposeSkill, skillManageTool } from "./skill-manage.ts";
import { type SkillServices, skillsListTool, skillViewTool } from "./skills.ts";

export type { JobRequest, ScheduleServices } from "./cronjob.ts";
export { type Args, defineTool, type Screen, type ToolAt, ToolFailed } from "./define.ts";
export { memoryLevel, memoryUsed } from "./memory.ts";
export { hitsForAgent } from "./session-search.ts";
export type { ProposeSkill, SkillEdit } from "./skill-manage.ts";
export type { ListedSkill, SkillServices } from "./skills.ts";

/** What Verdandi's tools need from verdandid. */
export type ToolServices = {
  readonly search: (query: string, allProjects: boolean, at: ToolAt) => Effect.Effect<readonly SessionHit[]>;
  readonly block: (reason: string, at: ToolAt) => Effect.Effect<void, ToolFailed>;
  readonly memory: MemoryServices;
  /** The user approves each memory save (DESIGN §14.2). */
  readonly approveMemorySaves: boolean;
  /** Scans the search tools' results for injection before the agent gets them. */
  readonly screen: Screen;
  /** Proposes a skill change and waits for the user's answer (DESIGN §14.4). */
  readonly proposeSkill: ProposeSkill;
  /** Lists and reads the user's skills (DESIGN §14.4). */
  readonly skills: SkillServices;
  /** Creates, lists and pauses scheduled jobs (DESIGN §15). */
  readonly schedules: ScheduleServices;
};

/** Every Verdandi tool, in a fixed order: harnesses serve this list unchanged for a session's life (DESIGN §9.6). */
export const verdandiTools = (services: ToolServices): readonly HarnessTool[] => [
  sessionSearchTool(services.search, services.screen),
  reportBlockedTool(services.block),
  memorySaveTool(services.memory, services.approveMemorySaves),
  memorySearchTool(services.memory, services.screen),
  skillManageTool(services.proposeSkill),
  skillsListTool(services.skills, services.screen),
  skillViewTool(services.skills, services.screen),
  cronjobTool(services.schedules),
];
