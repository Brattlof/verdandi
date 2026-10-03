import { codePointStart, type ProjectId, type SessionHit, type SessionQuery, type ThreadId, type TurnId } from "@verdandi/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { titleFrom } from "../event-store/projector.ts";

/** At most this many hits, newest first. */
const limit = 50;
/** Characters of context kept either side of a match. */
const context = 80;
const [open, close] = ["\u0001", "\u0002"];

/** User input as one FTS5 phrase, so file names, quotes and operators are text to find (ADR 0006). */
export const phrase = (query: string) => `"${query.replaceAll('"', '""')}"`;

/**
 * A little of `marked` around its first match, cut at whitespace where it can be, as text and match parts.
 * `marked` is a message with each match between \u0001 and \u0002, as FTS5's `highlight()` returns it.
 */
export const contextParts = (marked: string): SessionHit["parts"] => {
  const first = Math.max(marked.indexOf(open), 0);
  const last = marked.indexOf(close, first);
  let from = Math.max(first - context, 0);
  let to = Math.min((last < 0 ? first : last) + context, marked.length);
  if (from > 0) from = marked.indexOf(" ", from) + 1 || from;
  if (to < marked.length) to = marked.lastIndexOf(" ", to) > last ? marked.lastIndexOf(" ", to) : to;
  [from, to] = [codePointStart(marked, from), codePointStart(marked, to)]; // never half an emoji at either end
  const window = `${from > 0 ? "…" : ""}${marked.slice(from, to)}${to < marked.length ? "…" : ""}`;
  // Text and matches alternate, split at the markers; a match cut by the window keeps its half.
  return window
    .split(new RegExp(`(${open}[^${close}]*${close}?)`))
    .filter((p) => p.replaceAll(close, "") !== "")
    .map((p) =>
      p.startsWith(open) ? { text: p.slice(1).replaceAll(close, ""), match: true } : { text: p.replaceAll(close, ""), match: false },
    );
};

/** `SessionSearch`: past sessions' messages matching `query`, newest first. Under 3 characters, nothing: trigrams need 3. */
export const searchSessions = ({ query, projectId }: SessionQuery) =>
  Effect.gen(function* () {
    if ([...query.trim()].length < 3) return [];
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      thread_id: ThreadId;
      turn_id: TurnId;
      kind: SessionHit["kind"];
      at: string;
      marked: string;
      project_id: ProjectId;
      path: string;
      archived: number;
      first_text: string | null;
    }>`
      select s.thread_id, s.turn_id, s.kind, s.at, highlight(session_index, 0, ${open}, ${close}) as marked,
        t.project_id, p.path, t.archived_at is not null as archived,
        (select text from turns where thread_id = t.id order by started_at, rowid limit 1) as first_text
      from session_index s join threads t on t.id = s.thread_id join projects p on p.id = t.project_id
      where session_index match ${phrase(query.trim())} and (${projectId ?? null} is null or t.project_id = ${projectId ?? null})
      order by s.at desc, s.rowid desc limit ${limit}`;
    return rows.map(
      (r): SessionHit => ({
        threadId: r.thread_id,
        turnId: r.turn_id,
        projectId: r.project_id,
        projectPath: r.path,
        title: titleFrom(r.first_text ?? ""),
        archived: r.archived === 1,
        kind: r.kind,
        at: r.at,
        parts: contextParts(r.marked),
      }),
    );
  });
