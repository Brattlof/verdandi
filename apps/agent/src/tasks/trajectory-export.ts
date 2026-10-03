import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { decodeStoredEvent, type InteractionMode, type ProjectId, type RoutingExample, TaskOutcome, Trajectory } from "@verdandi/contracts";
import { redact, toMessageExamples } from "@verdandi/trajectories";
import { Effect, Schema } from "effect";
import { expandHome } from "../projects/project.ts";
import { openReadOnly } from "../routing/replay.ts";

/** `trajectories.yaml` in the Verdandi home: `excludeProjects` lists folders whose projects (and those inside them) are never exported. */
const SettingsFile = Schema.Struct({ excludeProjects: Schema.optionalKey(Schema.Array(Schema.String)) });

export const trajectorySettingsFile = (home: string) => join(home, "trajectories.yaml");

/** Paths compare as the OS does: Windows ignores case. */
const comparable = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);

/** The excluded folders as real paths when they exist, the way projects are stored. A broken file throws, naming the file and key. */
const loadExcluded = (home: string): string[] => {
  const file = trajectorySettingsFile(home);
  if (!existsSync(file)) return [];
  let data: typeof SettingsFile.Type;
  try {
    data = Schema.decodeUnknownSync(SettingsFile)(Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}, { onExcessProperty: "error" });
  } catch (e) {
    throw new Error(
      `${file}: ${e instanceof Error ? e.message : String(e)}\nFix the file (it takes excludeProjects: a list of folders), or delete it.`,
    );
  }
  return (data.excludeProjects ?? []).map((p) => {
    const path = resolve(expandHome(p));
    return comparable(existsSync(path) ? realpathSync.native(path) : path);
  });
};

const isExcluded = (excluded: readonly string[], projectPath: string) => {
  const path = comparable(projectPath);
  return excluded.some((ex) => path === ex || path.startsWith(ex.endsWith(sep) ? ex : ex + sep));
};

const decodeOutcome = Schema.decodeUnknownSync(TaskOutcome);

export type ExportFormat = "jsonl" | "routing";
export type ExportOptions = { readonly format: ExportFormat; readonly projectId?: ProjectId; readonly since?: Date };

/**
 * The saved trajectories (`jsonl`, a conversation per task) or task outcomes (`routing`, a row per task) as JSON
 * lines, oldest task first, secrets masked again with the current redactor (DESIGN §14.6). Tasks in excluded
 * projects, or started before `since`, are left out; `excluded` counts the former. Reads the database read-only.
 */
// ponytail: holds the whole export in memory; stream rows to the file when exports reach hundreds of MB.
export const exportTrajectories = (home: string, options: ExportOptions) => {
  const excludedPaths = loadExcluded(home);
  const db = openReadOnly(home);
  const after = (at: string) => options.since === undefined || Date.parse(at) >= options.since.getTime();
  try {
    if (options.format === "jsonl") {
      const rows = db
        .query<{ payload: string; path: string; started_at: string }, [string | null]>(
          `select j.payload, p.path, coalesce(k.started_at, t.started_at) as started_at
           from trajectories j join turns t on t.id = j.turn_id join threads h on h.id = j.thread_id
             join projects p on p.id = h.project_id left join tasks k on k.id = json_extract(j.payload, '$.taskId')
           where ?1 is null or h.project_id = ?1
           order by t.started_at, t.rowid`,
        )
        .all(options.projectId ?? null);
      const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Trajectory));
      const excluded = new Set<string>();
      const kept: Trajectory[] = [];
      for (const row of rows) {
        const trajectory = decode(row.payload);
        if (isExcluded(excludedPaths, row.path)) excluded.add(trajectory.taskId ?? trajectory.turnId);
        else if (after(row.started_at)) kept.push(redact(trajectory));
      }
      return { lines: toMessageExamples(kept).map((e) => `${JSON.stringify(e)}\n`), excluded: excluded.size };
    }
    const rows = db
      .query<
        {
          type: string;
          v: number;
          payload: string;
          at: string;
          path: string;
          project_id: ProjectId;
          text: string;
          mode: InteractionMode;
          images: number;
          outcome: string;
          cost_usd: number;
        },
        [string | null]
      >(
        `select e.type, e.v, e.payload, e.at, p.path, h.project_id, t.text, t.mode, o.payload as outcome, o.cost_usd,
           (select count(*) from json_each(t.attachments) where json_extract(value, '$.kind') = 'image') as images
         from events e join threads h on h.id = e.thread_id join projects p on p.id = h.project_id
           join turns t on t.id = json_extract(e.payload, '$.taskId')
           join task_outcomes o on o.task_id = json_extract(e.payload, '$.taskId')
         where e.type = 'task.started' and (?1 is null or h.project_id = ?1)
         order by e.seq`,
      )
      .all(options.projectId ?? null);
    let excluded = 0;
    const lines: string[] = [];
    for (const row of rows) {
      if (isExcluded(excludedPaths, row.path)) {
        excluded++;
        continue;
      }
      const e = Effect.runSync(decodeStoredEvent(row));
      if (e.type !== "task.started" || !after(row.at)) continue;
      const example: RoutingExample = {
        v: 1,
        taskId: e.taskId,
        threadId: e.threadId,
        projectId: row.project_id,
        startedAt: row.at,
        text: row.text,
        mode: row.mode,
        images: row.images,
        route: e.route,
        decision: e.decision ?? null,
        inputs: e.inputs ?? null,
        // Older outcomes read as v3: v1 without a rating, v1 and v2 without escalation triggers.
        outcome: decodeOutcome({ triggers: [], fallbacks: 0, ...JSON.parse(row.outcome), v: 4 }),
        costUsd: row.cost_usd,
      };
      lines.push(`${JSON.stringify(redact(example))}\n`);
    }
    return { lines, excluded };
  } finally {
    db.close();
  }
};
