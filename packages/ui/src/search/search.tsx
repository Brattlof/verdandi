import type { SessionHit } from "@verdandi/contracts";
import { useEffect, useRef, useState } from "react";
import type { Connection } from "../client.ts";
import { RuneText } from "../ui/runes.tsx";

const who: Record<SessionHit["kind"], string> = { user: "You", steer: "You, steering", assistant: "Agent" };

const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** The query is kept in the hash (`#view=search&q=...`), so Back from a result returns to it. */
const hashQuery = () => new URLSearchParams(location.hash.slice(1)).get("q") ?? "";

/**
 * The search page: past sessions as you type (3 characters or more), across every project, archived threads
 * included. A result jumps to its turn.
 */
export const SearchPage = ({ connection }: { connection: Connection }) => {
  const [query, setQuery] = useState(hashQuery);
  const [hits, setHits] = useState<readonly SessionHit[]>();
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  useEffect(() => {
    // Replacing the entry fires no hashchange, so typing doesn't re-render the app or pile up history.
    history.replaceState(null, "", `#${new URLSearchParams({ view: "search", ...(query && { q: query }) })}`);
    const q = query.trim();
    if ([...q].length < 3) return setHits(undefined);
    let current = true;
    // ponytail: a fixed 250 ms pause before each search. Upgrade: cancel in-flight searches if typing outpaces them.
    const timer = setTimeout(() => void connection.search({ query: q }).then((found) => current && setHits(found ?? [])), 250);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [connection, query]);
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1040px] px-5 py-10 sm:px-8 sm:py-14">
        <header className="mb-6">
          <p className="flex items-center gap-3 text-rune">
            <RuneText runes={["kenaz"]} className="h-4" />
            <span className="eyebrow text-muted">Kenaz · the torch</span>
          </p>
          <h1 className="mt-3 font-serif text-5xl leading-[0.95] font-bold tracking-tight uppercase sm:text-6xl">Search</h1>
        </header>
        <search className="max-w-2xl">
          <label htmlFor="session-search" className="eyebrow mb-2 block text-muted">
            Search past sessions
          </label>
          <input
            ref={field}
            id="session-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
            placeholder="A phrase, file name or error"
            autoComplete="off"
            spellCheck={false}
            className="w-full"
            aria-describedby="session-search-status"
          />
          <p id="session-search-status" role="status" className="mt-2 text-xs text-muted empty:hidden">
            {hits === undefined
              ? ""
              : hits.length === 0
                ? "No past messages match."
                : `${hits.length} ${hits.length === 1 ? "match" : "matches"}`}
          </p>
          {hits && hits.length > 0 && (
            <ul className="-mx-3 mt-2">
              {hits.map((h) => (
                <li key={`${h.turnId}-${h.kind}-${h.at}`}>
                  <a href={`#thread=${h.threadId}&turn=${h.turnId}`} className="block rounded-md px-3 py-2 hover:bg-hover">
                    <span className="flex gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium">{h.title || "New thread"}</span>
                      <span className="shrink-0 text-xs text-muted">
                        {projectName(h.projectPath)}
                        {h.archived && " · archived"}
                      </span>
                    </span>
                    <span className="block text-sm text-muted [overflow-wrap:anywhere]">
                      {who[h.kind]}:{" "}
                      {h.parts.map((p, i) =>
                        p.match ? (
                          // biome-ignore lint/suspicious/noArrayIndexKey: parts never reorder.
                          <mark key={i} className="rounded-sm bg-user text-fg">
                            {p.text}
                          </mark>
                        ) : (
                          p.text
                        ),
                      )}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </search>
      </div>
    </div>
  );
};
