import {
  type ClientCommand,
  type CommandId,
  historyLabel,
  type SkillHistoryEntry,
  type SkillSource,
  type SkillSummary,
  type SkillsView,
} from "@verdandi/contracts";
import { useCallback, useEffect, useId, useState } from "react";
import { type Connection, uuid } from "../client.ts";
import { TextDiff } from "../diffs/diff.tsx";
import { Rune } from "../ui/runes.tsx";

const titles = { profile: "Your skills", archived: "Archived, not loaded", extra: "Extra folder, read-only" } as const;

const day = (iso: string) => new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
const time = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
/** The skill's folder name, which commands name it by. */
const folderName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

/** Sends `command`: undefined once it's done, or why it was refused. */
type Send = (command: ClientCommand) => Promise<string | undefined>;

/**
 * The Skills tab (DESIGN §14.4): the profile's skills, which the agent proposes with skill_manage and the user
 * approves, and pins so agents can't change them; those Verdandi archived for going unused or that were deleted, which
 * the user can restore; and those in the read-only extra folders of `skills.yaml`, each under the folder it comes from.
 * A skill's history lists the changes written to it, each revertable after seeing its diff.
 */
export const SkillsTab = ({ connection }: { connection: Connection }) => {
  const [view, setView] = useState<SkillsView>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => void connection.skills().then(setView), [connection]);
  useEffect(load, [load]);
  const send: Send = async (command) => {
    const result = await connection.dispatch(command);
    load();
    return result.ok ? undefined : result.message;
  };
  const act = async (command: ClientCommand) => setError(await send(command));
  const restore = (s: SkillSummary) =>
    s.curation && act({ type: "skill.restore", commandId: uuid<CommandId>(), threadId: s.curation.threadId, skill: folderName(s.path) });
  const pin = (s: SkillSummary) =>
    act({ type: s.pinned ? "skill.unpin" : "skill.pin", commandId: uuid<CommandId>(), skill: folderName(s.path) });
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
        no longer loaded, until you restore it. A deleted skill is archived too. Pin a skill to keep agents from changing it and Verdandi
        from archiving it; History reverts a change.
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
                  <Skill
                    key={s.path}
                    skill={s}
                    source={source}
                    connection={connection}
                    send={send}
                    restore={() => void restore(s)}
                    pin={() => void pin(s)}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
};

/** One skill: its state and description, Pin or Restore, and its history, fetched when opened. */
const Skill = ({
  skill: s,
  source,
  connection,
  send,
  restore,
  pin,
}: {
  skill: SkillSummary;
  source: SkillSource;
  connection: Connection;
  send: Send;
  restore: () => void;
  pin: () => void;
}) => {
  const [open, setOpen] = useState(false);
  const historyId = useId();
  return (
    <li className="border-b border-line py-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono font-medium">
          {s.name}
          {s.pinned && <span className="ml-2 font-sans font-normal text-muted">pinned</span>}
          {s.curation && s.curation.state !== "active" && (
            <span className="ml-2 font-sans font-normal text-muted">
              {s.curation.state === "stale" ? "stale" : "archived"}, last used {day(s.curation.usedAt)}
            </span>
          )}
        </p>
        <div className="flex shrink-0 gap-1">
          {source !== "extra" && (
            <button
              type="button"
              className="px-2 text-xs"
              aria-expanded={open}
              aria-controls={historyId}
              aria-label={`History of ${s.name}`}
              onClick={() => setOpen(!open)}
            >
              History
            </button>
          )}
          {source === "profile" && (
            <button type="button" className="px-2 text-xs" aria-pressed={s.pinned === true} aria-label={`Pin ${s.name}`} onClick={pin}>
              {s.pinned ? "Unpin" : "Pin"}
            </button>
          )}
          {source === "archived" && s.curation?.state === "archived" && (
            <button type="button" className="px-2 text-xs" aria-label={`Restore ${s.name}`} onClick={restore}>
              Restore
            </button>
          )}
        </div>
      </div>
      <p className="mt-0.5 text-muted [overflow-wrap:anywhere]">{s.description || "No description in its SKILL.md."}</p>
      {open && (
        <div id={historyId}>
          <SkillHistory skill={folderName(s.path)} connection={connection} send={send} />
        </div>
      )}
    </li>
  );
};

/** The changes written to `skill`, newest first. Revert shows what it would put back, or why it can't, before it asks. */
const SkillHistory = ({ skill, connection, send }: { skill: string; connection: Connection; send: Send }) => {
  const [entries, setEntries] = useState<readonly SkillHistoryEntry[]>();
  const [asking, setAsking] = useState<string>();
  const [outcome, setOutcome] = useState<string>();
  const load = useCallback(async () => {
    const history = await connection.skillHistory(skill);
    setEntries(history);
    return history;
  }, [connection, skill]);
  useEffect(() => void load(), [load]);
  const revert = async (entry: SkillHistoryEntry) => {
    setAsking(undefined);
    const refused = await send({ type: "skill.revert", commandId: uuid<CommandId>(), threadId: entry.threadId, changeId: entry.changeId });
    // The revert is written before its receipt comes back, so the history already says how it went.
    const latest = (await load())?.[0];
    setOutcome(
      refused ??
        (latest?.reverts === entry.changeId && latest.error ? `Not reverted: ${latest.error}` : `Reverted: ${historyLabel(entry)}.`),
    );
  };
  if (!entries) return <p className="mt-1 text-muted">Loading its history…</p>;
  return (
    <div className="mt-1 border-l-2 border-line pl-2">
      {outcome && (
        <p role="status" className="mb-1 [overflow-wrap:anywhere]">
          {outcome}
        </p>
      )}
      {entries.length === 0 ? (
        <p className="text-muted">No change to it was written by Verdandi yet.</p>
      ) : (
        <ol aria-label={`Changes to ${skill}, newest first`}>
          {entries.map((e) => (
            <li key={e.changeId} className="py-1">
              <div className="flex items-center justify-between gap-2">
                <p>
                  <span className="font-mono">{historyLabel(e)}</span>
                  <span className="ml-2 text-muted">{time(e.at)}</span>
                </p>
                {!e.error && (
                  <button
                    type="button"
                    className="px-2 text-xs"
                    aria-expanded={asking === e.changeId}
                    onClick={() => setAsking(asking === e.changeId ? undefined : e.changeId)}
                  >
                    Revert
                  </button>
                )}
              </div>
              {e.error && <p className="text-error [overflow-wrap:anywhere]">Not written: {e.error}</p>}
              {asking === e.changeId &&
                (e.blocked ? (
                  <p role="alert" className="text-error [overflow-wrap:anywhere]">
                    Can't revert it: {e.blocked}
                  </p>
                ) : (
                  <div>
                    <p className="text-muted">Reverting puts back {e.change.path} as it was before this change:</p>
                    <section aria-label="What the revert changes" className="max-h-[30vh] overflow-y-auto border border-line bg-bg">
                      <TextDiff before={e.change.after ?? ""} after={e.change.before ?? ""} />
                    </section>
                    <div className="mt-1 flex justify-end gap-2">
                      <button type="button" className="px-2 text-xs" onClick={() => setAsking(undefined)}>
                        Cancel
                      </button>
                      <button type="button" className="px-2 text-xs" onClick={() => void revert(e)}>
                        Revert this change
                      </button>
                    </div>
                  </div>
                ))}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};
