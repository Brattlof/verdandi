import {
  type CommandId,
  describeCost,
  describeQuota,
  type ProjectSummary,
  type QuotaView,
  type SessionHit,
  type ThreadId,
  type ThreadSummary,
  type TurnId,
} from "@verdandi/contracts";
import { type FormEvent, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type Connection, createStore, useStore, uuid } from "./client.ts";
import { Dashboard } from "./spend/dashboard.tsx";
import { applyProjectsFeed, groupByRecency, type Sidebar as SidebarData } from "./state.ts";
import { ArchiveButton } from "./threads/archive.tsx";
import { ThreadPane } from "./threads/thread.tsx";
import { Engraving, Plait, Raven } from "./ui/art.tsx";
import { BranchIcon, CloseIcon, FolderIcon, MenuIcon, SidebarIcon } from "./ui/icons.tsx";
import { Rune, RuneMark, type RuneName, RuneText } from "./ui/runes.tsx";

/** The open thread lives in the URL hash (`#thread=<id>`), so links, Back and reloads just work. */
const hashThread = () => new URLSearchParams(location.hash.slice(1)).get("thread") as ThreadId | null;
/** `#view=spend` opens the spend dashboard instead of a thread; `#view=projects`, or no thread and no view, the projects page. */
const hashView = () => new URLSearchParams(location.hash.slice(1)).get("view");
const onHashChange = (listener: () => void) => {
  addEventListener("hashchange", listener);
  return () => removeEventListener("hashchange", listener);
};
/** `#thread=<id>&turn=<id>` scrolls the thread to that turn: where a search result points. */
const hashTurn = () => new URLSearchParams(location.hash.slice(1)).get("turn") as TurnId | null;
export const openThread = (threadId: ThreadId) => {
  location.hash = `thread=${threadId}`;
};

type Page = "home" | "thread" | "spend";

/** Whether the sidebar is folded away beside the rail, on screens wide enough to show both. Kept per browser. */
const sidebarKey = "verdandi.sidebar";

export const App = ({ connection }: { connection: Connection }) => {
  const [sidebar] = useState(() => createStore<SidebarData | undefined>(undefined));
  const threadId = useSyncExternalStore(onHashChange, hashThread);
  const view = useSyncExternalStore(onHashChange, hashView);
  const turn = useSyncExternalStore(onHashChange, hashTurn);
  const page: Page = view === "spend" ? "spend" : threadId ? "thread" : "home";
  const data = useStore(sidebar);
  const lost = useStore(connection.lost);
  // Showing archived threads asks verdandid for a feed that includes them; hiding them goes back to one that doesn't.
  const [archived, setArchived] = useState(false);
  // Below the md breakpoint the sidebar is a drawer over the page; it closes on navigation and on Escape.
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(sidebarKey) === "collapsed");
  // Bumped to show the search field and move focus into it.
  const [searchRequests, setSearchRequests] = useState(0);
  const menuButton = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigating is the trigger, not an input.
  useEffect(() => setNavOpen(false), [threadId, view]);
  const closeNav = () => {
    setNavOpen(false);
    menuButton.current?.focus();
  };
  const fold = (fold: boolean) => {
    setCollapsed(fold);
    localStorage.setItem(sidebarKey, fold ? "collapsed" : "open");
  };
  const search = () => {
    fold(false);
    setSearchRequests((n) => n + 1);
  };
  useEffect(() => {
    // A message the previous feed sends after this one started must not be folded in with the new setting.
    let current = true;
    const stop = connection.follow(
      (rpc, subscriptionId) => rpc.ProjectsSubscribe({ subscriptionId, archived }),
      (feed) => current && sidebar.set(applyProjectsFeed(sidebar.get(), feed, archived)),
      () => {},
    );
    return () => {
      current = false;
      stop();
    };
  }, [connection, sidebar, archived]);
  const currentThread = threadId ? data?.threads.find((t) => t.threadId === threadId) : undefined;
  return (
    <div className="flex h-dvh">
      {/* The hash holds the open thread, so skipping moves focus rather than following a link. */}
      <button
        type="button"
        onClick={() => document.getElementById("main")?.focus()}
        className="sr-only z-50 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to main content
      </button>
      {lost && (
        <div role="alert" className="fixed inset-x-0 top-0 z-50 flex flex-wrap items-center gap-x-2 bg-error px-4 py-2 text-bg">
          Lost the connection to verdandid.
          <button type="button" className="border-bg bg-bg px-2 text-fg" onClick={() => location.reload()}>
            Reconnect
          </button>
          If verdandid restarted, run <code>verdandi open</code> again.
        </div>
      )}
      {navOpen && (
        // Clicking beside the drawer closes it; keyboard users have Escape and the Close button.
        <button
          type="button"
          aria-label="Close menu"
          tabIndex={-1}
          className="fixed inset-0 z-30 rounded-none border-0 bg-bg/80 hover:bg-bg/80 md:hidden"
          onClick={closeNav}
        />
      )}
      <Rail page={page} sidebarOpen={!collapsed} onSidebar={() => fold(!collapsed)} onSearch={search} />
      <Sidebar
        connection={connection}
        data={data}
        page={page}
        current={page === "thread" ? threadId : null}
        currentProject={currentThread?.projectId}
        archived={archived}
        onArchived={setArchived}
        open={navOpen}
        collapsed={collapsed}
        searchRequests={searchRequests}
        onSearch={search}
        onFold={() => fold(true)}
        onClose={closeNav}
      />
      <main id="main" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col outline-none">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-panel px-2 md:hidden">
          <button
            ref={menuButton}
            type="button"
            aria-label="Open menu"
            aria-expanded={navOpen}
            className="border-0 bg-transparent px-2"
            onClick={() => setNavOpen(true)}
          >
            <MenuIcon />
          </button>
          <Wordmark />
        </div>
        {page === "spend" ? (
          <Dashboard connection={connection} projects={data?.projects ?? []} />
        ) : threadId ? (
          <ThreadPane key={threadId} connection={connection} threadId={threadId} focusTurn={turn} />
        ) : (
          <Home connection={connection} data={data} />
        )}
      </main>
    </div>
  );
};

/** The mark, the name, and the name in runes beneath it. `rail`: the rail beside it already shows the mark, on wider screens. */
const Wordmark = ({ rail = false }: { rail?: boolean }) => (
  <span className="flex items-center gap-2">
    <RuneMark className={`size-7 ${rail ? "md:hidden" : ""}`} />
    <span className="flex flex-col gap-1">
      <span className="font-serif text-xl leading-none font-semibold tracking-tight">Verdandi</span>
      <RuneText className="h-2 text-rune" />
    </span>
  </span>
);

const basename = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** The current page's link or button: the pale sky surface, as in the sidebar reference. */
const currentItem = "hover:bg-hover aria-[current=page]:bg-user aria-[current=page]:font-medium";

/** Rail buttons: a rune over its name; the current page on the sky surface, a pressed toggle (the sidebar shown) only in ink. */
const railItem = `flex h-14 w-14 flex-col items-center justify-center gap-1.5 rounded-md border-0 bg-transparent p-0 text-muted hover:text-fg aria-[current=page]:text-accent aria-pressed:text-fg ${currentItem}`;

/** A rail entry's rune and name; the rune's own name and meaning show on hover. */
const RailLabel = ({ rune, label }: { rune: RuneName; label: string }) => (
  <>
    <Rune name={rune} className="size-5" />
    <span className="text-[10px] leading-none font-semibold tracking-[0.08em] uppercase">{label}</span>
  </>
);

/**
 * The narrow column of destinations beside the sidebar, on screens wide enough for both. It stays when the
 * sidebar is folded away, so every page is one click from anywhere.
 */
const Rail = ({
  page,
  sidebarOpen,
  onSidebar,
  onSearch,
}: {
  page: Page;
  sidebarOpen: boolean;
  onSidebar: () => void;
  onSearch: () => void;
}) => (
  <nav aria-label="Main" className="hidden w-[72px] shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-3 md:flex">
    <RuneMark className="mb-4 size-8" />
    <a href="#view=projects" title="Projects (ingwaz: the hearth)" aria-current={page === "home" ? "page" : undefined} className={railItem}>
      <RailLabel rune="ingwaz" label="Projects" />
    </a>
    <button type="button" title="Threads (laguz: the well)" aria-pressed={sidebarOpen} className={railItem} onClick={onSidebar}>
      <RailLabel rune="laguz" label="Threads" />
    </button>
    <button
      type="button"
      aria-label="Search past sessions"
      title="Search past sessions (kenaz: the torch)"
      className={railItem}
      onClick={onSearch}
    >
      <RailLabel rune="kenaz" label="Search" />
    </button>
    <a
      href="#view=spend"
      aria-label="Spend dashboard"
      title="Spend dashboard (fehu: wealth)"
      aria-current={page === "spend" ? "page" : undefined}
      className={railItem}
    >
      <RailLabel rune="fehu" label="Spend" />
    </a>
  </nav>
);

const Sidebar = ({
  connection,
  data,
  page,
  current,
  currentProject,
  archived,
  onArchived,
  open,
  collapsed,
  searchRequests,
  onSearch,
  onFold,
  onClose,
}: {
  connection: Connection;
  data: SidebarData | undefined;
  page: Page;
  current: ThreadId | null;
  /** The open thread's project, where New thread starts one. */
  currentProject: ThreadSummary["projectId"] | undefined;
  archived: boolean;
  onArchived: (archived: boolean) => void;
  /** Whether the drawer is open, on screens too narrow to show the sidebar beside the page. */
  open: boolean;
  /** Whether the sidebar is folded away beside the rail, on wider screens. */
  collapsed: boolean;
  searchRequests: number;
  onSearch: () => void;
  onFold: () => void;
  onClose: () => void;
}) => {
  const nav = useRef<HTMLElement>(null);
  // Focus moves into the drawer when it opens, so keyboard users land in it.
  useEffect(() => {
    if (open) nav.current?.focus();
  }, [open]);
  const project = data?.projects.find((p) => p.projectId === currentProject);
  return (
    <nav
      ref={nav}
      aria-label="Threads"
      tabIndex={-1}
      onKeyDown={(e) => open && e.key === "Escape" && onClose()}
      className={`${open ? "fixed inset-y-0 left-0 z-40 flex shadow-2xl" : "hidden"} ${collapsed ? "" : "md:flex"} w-72 max-w-[85vw] shrink-0 flex-col border-r border-line bg-panel outline-none md:static md:w-64 md:max-w-none md:shadow-none`}
    >
      <div className="flex h-16 shrink-0 items-center justify-between gap-2 pr-2 pl-4">
        <Wordmark rail />
        <span className="flex">
          <button type="button" aria-label="Close menu" className={`${ghostIcon} md:hidden`} onClick={onClose}>
            <CloseIcon />
          </button>
          <button
            type="button"
            aria-label="Hide the sidebar"
            title="Hide the sidebar"
            className={`${ghostIcon} hidden md:flex`}
            onClick={onFold}
          >
            <SidebarIcon />
          </button>
        </span>
      </div>
      <div className="px-2">
        <NewThread connection={connection} project={project} />
        <a href="#view=projects" aria-current={page === "home" ? "page" : undefined} className={`${row} ${currentItem}`}>
          <Rune name="ingwaz" className="text-muted" />
          Projects
        </a>
        <a href="#view=spend" aria-current={page === "spend" ? "page" : undefined} className={`${row} ${currentItem}`}>
          <Rune name="fehu" className="text-muted" />
          Spend dashboard
        </a>
        {/* A row, not a header icon: kenaz alone reads as a Back arrow. */}
        <button
          type="button"
          className={`${row} w-full justify-start border-0 bg-transparent font-normal hover:bg-hover`}
          onClick={onSearch}
        >
          <Rune name="kenaz" className="text-muted" />
          Search past sessions
        </button>
      </div>
      <SearchSessions connection={connection} requests={searchRequests} />
      <div className="mt-2 flex-1 overflow-y-auto px-2 pb-3">
        {data && <ThreadList connection={connection} data={data} current={current} />}
      </div>
      <footer className="px-4 pb-2">
        <Plait surface="stroke-panel" className="mb-1 text-line-strong" />
        {data && <Quotas quotas={data.quotas} />}
        <label className="flex items-center py-1 text-xs text-muted">
          <input type="checkbox" checked={archived} onChange={(e) => onArchived(e.target.checked)} />
          Show archived threads
        </label>
      </footer>
    </nav>
  );
};

const row = "flex min-h-9 items-center gap-2.5 rounded-md px-2 py-1.5";
const ghostIcon = "size-9 border-0 bg-transparent p-0 text-muted hover:text-fg";

/**
 * Starts a thread in the open thread's project, routed by the router; with no thread open it leads to the
 * projects page, where a folder is picked.
 */
const NewThread = ({ connection, project }: { connection: Connection; project: ProjectSummary | undefined }) => {
  const [error, setError] = useState<string>();
  if (!project)
    return (
      <a href="#view=projects" className={`${row} hover:bg-hover`}>
        <Rune name="berkano" className="text-muted" />
        New thread
      </a>
    );
  const create = async () => {
    const threadId = uuid<ThreadId>();
    const result = await connection.dispatch({
      type: "thread.create",
      commandId: uuid<CommandId>(),
      threadId,
      projectPath: project.path,
    });
    setError(result.ok ? undefined : result.message);
    if (result.ok) openThread(threadId);
  };
  return (
    <>
      <button type="button" className={`${row} w-full justify-start border-0 bg-transparent font-normal`} onClick={create}>
        <Rune name="berkano" className="text-muted" />
        New thread
        <span className="min-w-0 truncate text-xs text-muted">in {basename(project.path)}</span>
      </button>
      {error && (
        <p role="alert" className="mx-2 text-xs text-error">
          {error}
        </p>
      )}
    </>
  );
};

/** Threads by recency, as in the sidebar reference: each with its title, project, and whether it's working. */
const ThreadList = ({ connection, data, current }: { connection: Connection; data: SidebarData; current: ThreadId | null }) => {
  const [error, setError] = useState<string>();
  const names = new Map(data.projects.map((p) => [p.projectId, basename(p.path)]));
  if (data.threads.length === 0)
    return (
      <p className="mx-2 mt-2 text-xs text-muted">
        No threads spun yet. Open a project folder from <a href="#view=projects">Projects</a>, or run <code>verdandi chat</code> in one.
      </p>
    );
  return (
    <>
      {error && (
        <p role="alert" className="mx-2 text-xs text-error">
          {error}
        </p>
      )}
      {groupByRecency(data.threads, new Date()).map((group) => (
        <section key={group.label} aria-label={group.label} className="mt-3 first:mt-1">
          <h2 className="px-2 pb-1 text-xs font-medium text-muted">{group.label}</h2>
          <ul>
            {group.threads.map((t) => (
              <ThreadRow
                key={t.threadId}
                connection={connection}
                thread={t}
                project={names.get(t.projectId) ?? ""}
                current={t.threadId === current}
                onError={setError}
              />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
};

const ThreadRow = ({
  connection,
  thread: t,
  project,
  current,
  onError,
}: {
  connection: Connection;
  thread: ThreadSummary;
  project: string;
  current: boolean;
  onError: (message: string | undefined) => void;
}) => (
  <li className="group relative flex items-center gap-1">
    <a
      href={`#thread=${t.threadId}`}
      aria-current={current ? "page" : undefined}
      className={`flex min-w-0 flex-1 flex-col rounded-md px-2 py-1.5 ${currentItem}`}
    >
      <span className={`flex items-center gap-1.5 ${t.archived ? "text-muted" : ""}`}>
        {/* A slot for every row, so titles line up whether or not their thread is working. */}
        <span className={`size-1.5 shrink-0 rounded-full ${t.busy ? "bg-accent" : ""}`}>
          {t.busy && <span className="sr-only">Working: </span>}
        </span>
        <span className="truncate">{t.title || "New thread"}</span>
      </span>
      <span className="flex min-w-0 items-center gap-x-1.5 pl-3 text-xs text-muted">
        <span className="truncate">{project}</span>
        {t.archived && <span className="shrink-0">· archived</span>}
        {describeCost(t.cost) && (
          <span
            className="shrink-0 tabular-nums"
            title="Paid: metered usage. On plan: subscription usage valued at API prices, covered by your plan."
          >
            · {describeCost(t.cost)}
          </span>
        )}
      </span>
    </a>
    {/* With a mouse, Archive shows over the row on hover or keyboard focus; on touch screens, and for Unarchive, it sits beside it. */}
    {!t.busy && (
      <ArchiveButton
        connection={connection}
        threadId={t.threadId}
        archived={t.archived}
        title={t.title || "New thread"}
        className={`shrink-0 ${t.archived ? "" : "pointer-fine:absolute pointer-fine:top-1.5 pointer-fine:right-1 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-visible:opacity-100"}`}
        onError={onError}
      />
    )}
  </li>
);

const resetTime = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** Each harness's subscription window, as it last reported it. A live region, so a switch to extra usage is announced. */
const Quotas = ({ quotas }: { quotas: readonly QuotaView[] }) => (
  <div role="status">
    {quotas.map((q) => {
      const alert = q.quota.usingOverage || q.quota.status !== "allowed";
      return (
        <p key={q.harness} className={`flex gap-2 py-1 text-xs ${alert ? "text-error" : "text-muted"}`}>
          <span aria-hidden className={`mt-1.5 size-1.5 shrink-0 rounded-full ${alert ? "bg-error" : "bg-ok"}`} />
          {describeQuota(q, resetTime)}
        </p>
      );
    })}
  </div>
);

const who: Record<SessionHit["kind"], string> = { user: "You", steer: "You, steering", assistant: "Agent" };

/**
 * Searches past sessions as you type (3 characters or more), across every project, archived threads included.
 * A result jumps to its turn. Hidden until asked for (`requests` counts the asks), and again on Escape once empty.
 */
const SearchSessions = ({ connection, requests }: { connection: Connection; requests: number }) => {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<readonly SessionHit[]>();
  const [shown, setShown] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (requests === 0) return;
    setShown(true);
    // Shown on this render, focused once it's in the page.
    requestAnimationFrame(() => field.current?.focus());
  }, [requests]);
  useEffect(() => {
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
  if (!shown) return null;
  return (
    <search className="mt-3 px-4">
      <label htmlFor="session-search" className="eyebrow mb-1 block text-muted">
        Search past sessions
      </label>
      <input
        ref={field}
        id="session-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          if (query) setQuery("");
          else setShown(false);
        }}
        placeholder="A phrase, file name or error"
        autoComplete="off"
        spellCheck={false}
        className="w-full text-xs"
        aria-describedby="session-search-status"
      />
      <p id="session-search-status" role="status" className="mt-1 text-xs text-muted empty:hidden">
        {hits === undefined
          ? ""
          : hits.length === 0
            ? "No past messages match."
            : `${hits.length} ${hits.length === 1 ? "match" : "matches"}`}
      </p>
      {hits && hits.length > 0 && (
        <ul className="-mx-2 mt-1 max-h-80 overflow-y-auto border-b border-line pb-2">
          {hits.map((h) => (
            <li key={`${h.turnId}-${h.kind}-${h.at}`}>
              <a href={`#thread=${h.threadId}&turn=${h.turnId}`} className="block rounded-md px-2 py-1.5 text-xs hover:bg-hover">
                <span className="flex gap-1.5">
                  <span className="min-w-0 flex-1 truncate font-medium">{h.title || "New thread"}</span>
                  {h.archived && <span className="shrink-0 text-muted">archived</span>}
                </span>
                <span className="block text-muted [overflow-wrap:anywhere]">
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
  );
};

/** The projects page: open any folder to start a thread, or start one in a project you've worked in. */
const Home = ({ connection, data }: { connection: Connection; data: SidebarData | undefined }) => {
  const threads = Map.groupBy(data?.threads ?? [], (t) => t.projectId);
  // Projects with the most recent activity first; `data.threads` is already in that order.
  const projects = (data?.projects ?? []).toSorted(
    (a, b) =>
      (data?.threads.findIndex((t) => t.projectId === a.projectId) ?? 0) -
      (data?.threads.findIndex((t) => t.projectId === b.projectId) ?? 0),
  );
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1080px] px-5 py-10 sm:px-8 sm:py-14">
        <div className="grid items-start gap-10 lg:grid-cols-[1fr_340px]">
          <div>
            <p className="flex items-center gap-3 text-rune">
              <RuneText className="h-3.5" />
              <span className="eyebrow text-muted">Verðandi · what is becoming</span>
            </p>
            <h1 className="mt-4 font-serif text-5xl leading-[0.95] font-bold tracking-tight uppercase sm:text-7xl">Projects</h1>
            <p className="mt-5 max-w-lg font-serif text-xl leading-snug">
              Beneath Yggdrasil three norns spin the threads of fate: Urðr what was, Verðandi what is becoming, Skuld what shall be.
            </p>
            <p className="mt-3 max-w-lg text-muted">
              Open a folder to begin a thread. Each task goes to the harness, model and effort that finish it for the least.
            </p>
            <OpenFolder connection={connection} />
          </div>
          <Engraving className="mx-auto w-full max-w-[220px] lg:max-w-[340px]" />
        </div>
        {projects.length > 0 && (
          <section aria-labelledby="your-projects" className="mt-12">
            <Plait className="mb-8 text-rune" />
            <h2 id="your-projects" className="eyebrow mb-4 text-muted">
              Your projects
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {projects.map((p, i) => (
                <ProjectCard
                  key={p.projectId}
                  connection={connection}
                  project={p}
                  threads={threads.get(p.projectId) ?? []}
                  lead={i === 0}
                />
              ))}
            </ul>
          </section>
        )}
        <p className="mt-16 border-t border-line pt-3 text-xs text-muted">
          Engraving by Ludwig Burger, 1882, in the public domain. Raven and longship by Lorc and Delapouite from{" "}
          <a href="https://game-icons.net" target="_blank" rel="noreferrer" className="underline underline-offset-2">
            game-icons.net
          </a>
          ,{" "}
          <a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noreferrer" className="underline underline-offset-2">
            CC BY 3.0
          </a>
          .
        </p>
      </div>
    </div>
  );
};

/** Starts a thread in any folder; verdandid checks the path and resolves it, so a known folder gets a new thread, not a new project. */
const OpenFolder = ({ connection }: { connection: Connection }) => {
  const [error, setError] = useState<string>();
  const open = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const projectPath = String(data.get("path")).trim();
    if (!projectPath) return;
    const threadId = uuid<ThreadId>();
    const worktree = data.get("worktree") === "on";
    const result = await connection.dispatch({
      type: "thread.create",
      commandId: uuid<CommandId>(),
      threadId,
      projectPath,
      ...(worktree && { worktree }),
    });
    setError(result.ok ? undefined : result.message);
    if (!result.ok) return;
    form.reset();
    openThread(threadId);
  };
  return (
    <form onSubmit={open} className="mt-8 max-w-2xl">
      <label htmlFor="open-folder-path" className="eyebrow mb-2 block text-muted">
        Open folder
      </label>
      <div className="flex items-center gap-2 rounded-lg border border-line-strong bg-card p-1.5 pl-3 focus-within:border-accent focus-within:shadow-[0_0_0_1px_var(--color-accent)]">
        <FolderIcon className="text-muted" />
        <input
          id="open-folder-path"
          type="text"
          name="path"
          placeholder="Full path to a project folder"
          required
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 border-0 bg-transparent px-1 font-mono text-[13px] outline-none focus-visible:outline-none"
          aria-invalid={error !== undefined}
          aria-describedby={error ? "open-folder-error" : undefined}
        />
        <button type="submit" className="min-h-8 px-4">
          Open
        </button>
      </div>
      <label className="mt-2 flex items-center text-xs text-muted">
        <input type="checkbox" name="worktree" />
        In a git worktree of its own
      </label>
      {error && (
        <p id="open-folder-error" role="alert" className="mt-1 text-xs text-error [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </form>
  );
};

const activity = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/**
 * One project: how many threads it has, in a large figure, and the ways to start another. The most recently
 * active project leads, on the sky surface.
 */
const ProjectCard = ({
  connection,
  project,
  threads,
  lead,
}: {
  connection: Connection;
  project: ProjectSummary;
  threads: readonly ThreadSummary[];
  lead: boolean;
}) => {
  const [error, setError] = useState<string>();
  // Without a route, the router picks one for each task of the new thread.
  const newThread = async (worktree: boolean) => {
    const threadId = uuid<ThreadId>();
    const result = await connection.dispatch({
      type: "thread.create",
      commandId: uuid<CommandId>(),
      threadId,
      projectPath: project.path,
      ...(worktree && { worktree }),
    });
    if (result.ok) openThread(threadId);
    else setError(result.message);
  };
  const name = basename(project.path);
  const last = threads[0]?.lastActivityAt;
  return (
    <li className={`relative flex flex-col border border-line p-5 ${lead ? "bg-user" : "bg-card"}`}>
      {/* As on the Norse reference, a raven alights on the leading card. */}
      {lead && <Raven className="absolute -top-9 right-5 size-16 text-fg" />}
      <p aria-hidden className="font-serif text-5xl leading-none font-semibold tabular-nums">
        {threads.length}
      </p>
      <h3 className="mt-4 font-serif text-2xl leading-tight font-semibold [overflow-wrap:anywhere]">
        {name}
        <span className="sr-only">
          , {threads.length} {threads.length === 1 ? "thread" : "threads"}
        </span>
      </h3>
      <p title={project.path} className="mt-1 truncate font-mono text-xs text-muted">
        {project.path}
      </p>
      {last && <p className="mt-1 text-xs text-muted">Last active {activity(last)}</p>}
      {error && (
        <p role="alert" className="mt-2 text-xs text-error">
          {error}
        </p>
      )}
      <span className="mt-auto flex flex-wrap gap-x-5 gap-y-1 pt-5">
        <Action onClick={() => newThread(false)} label={`New thread in ${name}`}>
          <Rune name="berkano" className="size-3.5" />
          New thread
        </Action>
        <Action onClick={() => newThread(true)} label={`New thread in a git worktree of ${name}`}>
          <BranchIcon className="size-3.5" />
          Worktree
        </Action>
      </span>
    </li>
  );
};

const Action = ({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) => (
  <button type="button" className="caps-link" aria-label={label} title={label} onClick={onClick}>
    {children}
  </button>
);
