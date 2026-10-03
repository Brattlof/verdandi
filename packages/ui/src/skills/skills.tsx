import type { CommandId, SkillSummary, SkillsView } from "@verdandi/contracts";
import { useCallback, useEffect, useState } from "react";
import { type Connection, uuid } from "../client.ts";
import { Rune } from "../ui/runes.tsx";

const titles = { profile: "Your skills", archived: "Archived, not loaded", extra: "Extra folder, read-only" } as const;

const day = (iso: string) => new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
/** The skill's folder name, which commands name it by. */
const folderName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

/**
 * The Skills tab (DESIGN §14.4): the profile's skills, which the agent proposes with skill_manage and the user
 * approves, those Verdandi archived for going unused, which the user can restore, and those in the read-only extra
 * folders of `skills.yaml`, each under the folder it comes from.
 */
export const SkillsTab = ({ connection }: { connection: Connection }) => {
  const [view, setView] = useState<SkillsView>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => void connection.skills().then(setView), [connection]);
  useEffect(load, [load]);
  const restore = async (s: SkillSummary) => {
    if (!s.curation) return;
    const result = await connection.dispatch({
      type: "skill.restore",
      commandId: uuid<CommandId>(),
      threadId: s.curation.threadId,
      skill: folderName(s.path),
    });
    setError(result.ok ? undefined : result.message);
    load();
  };
  if (!view) return <p className="p-3 text-xs text-muted">Loading…</p>;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-serif text-lg font-semibold">
          <Rune name="ansuz" className="size-5" />
          Skills
        </p>
        <button type="button" className="text-xs" onClick={load}>
          Refresh
        </button>
      </div>
      <p className="mt-1 text-muted">
        The agent proposes skills with skill_manage, and nothing is written until you approve the diff. Claude Code loads yours in new
        sessions as verdandi:&lt;name&gt;. A skill Verdandi created goes stale after 14 days unused and is archived after 30: kept on disk,
        no longer loaded, until you restore it.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-error [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
      {view.folders.map(({ path, source, skills }, i) => {
        const headingId = `skills-folder-${i}`;
        return (
          <section key={path} aria-labelledby={headingId} className="mt-4">
            <h3 id={headingId} className="font-serif text-lg font-semibold">
              {titles[source]}
            </h3>
            <p title={path} className="truncate font-mono text-muted">
              {path}
            </p>
            {skills.length === 0 ? (
              <p className="mt-1 text-muted">No skills here yet.</p>
            ) : (
              <ul className="mt-1">
                {skills.map((s) => (
                  <li key={s.path} className="border-b border-line py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-mono font-medium">
                        {s.name}
                        {s.curation && s.curation.state !== "active" && (
                          <span className="ml-2 font-sans font-normal text-muted">
                            {s.curation.state === "stale" ? "stale" : "archived"}, last used {day(s.curation.usedAt)}
                          </span>
                        )}
                      </p>
                      {source === "archived" && s.curation?.state === "archived" && (
                        <button type="button" className="px-2 text-xs" aria-label={`Restore ${s.name}`} onClick={() => void restore(s)}>
                          Restore
                        </button>
                      )}
                    </div>
                    <p className="mt-0.5 text-muted [overflow-wrap:anywhere]">{s.description || "No description in its SKILL.md."}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
};
